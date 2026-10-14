import {
  ANDROID_KEYCODES,
  FrameType,
  type Frame,
  KeyAction,
  SCRCPY_CODEC_ID_H264,
  SCRCPY_CODEC_META_SIZE,
  SCRCPY_DEVICE_NAME_FIELD_LENGTH,
  SCRCPY_PACKET_HEADER_SIZE,
  SCRCPY_POINTER_ID_GENERIC_FINGER,
  SCRCPY_POINTER_ID_VIRTUAL_FINGER,
  ScrcpyControlType,
  VideoCodec,
  androidMetaState,
  denormalize,
  encodeFrame,
  findSps,
  parseScrcpyPacketHeader,
  scrcpyInjectKeycode,
  scrcpyInjectScroll,
  scrcpyInjectText,
  scrcpyInjectTouch,
  scrcpyServerArgs,
  scrcpySetClipboard,
  scrcpySimple,
} from '@devicelab/protocol';
import type { StreamQuality } from '@devicelab/shared-types';
import { randomInt } from 'node:crypto';
import net from 'node:net';
import { type Duplex } from 'node:stream';
import { type Logger } from '../../logger';
import { type StreamHandle, type StreamSink } from '../driver';
import { type AdbBridge, withTimeout } from './adb';
import { ByteReader } from './byte-reader';
import { deviceCrashLog } from './diagnostics';

export const DEVICE_JAR_PATH = '/data/local/tmp/scrcpy-server.jar';

/** A black frame at typical bit rates encodes to a tiny IDR; real UIs are far larger. */
const SECURE_IDR_MAX_BYTES = 6 * 1024;
const STALL_PROBE_MS = 5000;
const STALL_RESTART_MS = 8000;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() =>
        typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port')),
      );
    });
  });
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.setNoDelay(true);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One scrcpy-server run on the device: H.264 video socket + control socket over
 * an adb forward. Restarts itself if the stream stalls.
 */
export class ScrcpySession implements StreamHandle {
  private videoSocket: net.Socket | null = null;
  private controlSocket: net.Socket | null = null;
  private serverProc: Duplex | null = null;
  private port = 0;
  private stopped = false;
  private frameW = 0;
  private frameH = 0;
  private lastPacketAt = 0;
  private resetSentAt = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private restarts: number[] = [];
  private smallIdrs = 0;
  private secure = false;

  constructor(
    private readonly adb: AdbBridge,
    private readonly serial: string,
    private quality: StreamQuality,
    private readonly sink: StreamSink,
    private readonly log: Logger,
    private readonly codecOptions?: string,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    const scid = randomInt(0, 0x7fffffff).toString(16).padStart(8, '0');
    this.port = await freePort();
    const step = (msg: string): void => {
      this.log.info({ serial: this.serial }, `stream start: ${msg}`);
      this.sink.status('starting', msg);
    };
    step(`adb forward tcp:${this.port} → scrcpy_${scid}`);
    await withTimeout(
      this.adb.forward(this.serial, `tcp:${this.port}`, `localabstract:scrcpy_${scid}`),
      10_000,
      'adb forward timed out (is the adb server responsive? try `adb kill-server`)',
    );
    const cmd = scrcpyServerArgs({
      scid,
      maxSize: this.quality.maxSize,
      bitRate: this.quality.bitRate,
      maxFps: this.quality.maxFps,
      jarPath: DEVICE_JAR_PATH,
      codecOptions: this.codecOptions,
    });
    step('Starting scrcpy-server on the device…');
    this.serverProc = await withTimeout(
      this.adb.shellStream(this.serial, cmd),
      10_000,
      'adb shell did not open (device busy or adb unresponsive)',
    );
    let serverOutput = '';
    this.serverProc.on('data', (d: Buffer) => {
      const text = d.toString().trim();
      if (!text) return;
      serverOutput = (serverOutput + '\n' + text).slice(-2000);
      this.log.info({ scrcpy: text }, 'scrcpy-server output');
      if (/ERROR|Exception/.test(text)) this.sink.status('error', text.slice(0, 300));
    });
    let exited = false;
    this.serverProc.on('end', () => {
      exited = true;
    });
    this.serverProc.on('close', () => {
      exited = true;
    });
    const fail = (msg: string): Error =>
      new Error(
        serverOutput ? `${msg}. scrcpy-server said: ${serverOutput.trim().slice(-400)}` : msg,
      );
    /** Same as fail(), plus the device log lines that explain a crash. */
    const failWithDeviceLog = async (msg: string): Promise<Error> => {
      const lines = await deviceCrashLog(this.adb, this.serial);
      if (lines.length)
        this.log.error({ serial: this.serial, deviceLog: lines }, 'scrcpy-server crash log');
      const err = fail(msg);
      return lines.length
        ? new Error(`${err.message}. Device log: ${lines.slice(-6).join(' | ').slice(0, 900)}`)
        : err;
    };

    // With tunnel_forward the adb forward accepts immediately; the server is ready once the
    // dummy byte arrives on the first (video) socket. Give it ~12 s (first start can be slow).
    let video: net.Socket | null = null;
    let reader: ByteReader | null = null;
    const deadline = Date.now() + 12_000;
    // Stop waiting as soon as the server process has died (e.g. "Aborted").
    while (Date.now() < deadline && !this.stopped && !(exited && serverOutput)) {
      let s: net.Socket | null = null;
      try {
        s = await connect(this.port);
        const r = new ByteReader(s);
        await withTimeout(r.read(1), 1500, 'no dummy byte');
        video = s;
        reader = r;
        break;
      } catch {
        s?.destroy();
        await sleep(150);
      }
    }
    if (!video || !reader) {
      throw await failWithDeviceLog(
        exited
          ? 'scrcpy-server exited on the device before accepting connections'
          : 'scrcpy-server did not start (check the jar is v3.3.1 and USB debugging is allowed)',
      );
    }
    this.videoSocket = video;
    step('Video socket connected; opening control socket…');

    // The server accepts video → control, and only then sends device meta + codec meta.
    // Connect the control socket BEFORE reading anything else, or both sides wait forever.
    this.controlSocket = await connect(this.port);
    this.controlSocket.on('data', () => undefined); // device → client messages (clipboard echo) are ignored
    this.controlSocket.on('error', () => undefined);

    const nameField = await withTimeout(
      reader.read(SCRCPY_DEVICE_NAME_FIELD_LENGTH),
      8_000,
      'scrcpy-server sent no device metadata',
    ).catch((e: Error) => Promise.reject(fail(e.message)));
    const deviceName = nameField.toString('utf8').replace(/\0.*$/s, '');
    step('Waiting for the device video encoder…');
    const codecMeta = await withTimeout(
      reader.read(SCRCPY_CODEC_META_SIZE),
      8_000,
      'scrcpy-server sent no video header (the device encoder may have failed — try a lower quality)',
    ).catch((e: Error) => Promise.reject(fail(e.message)));
    const codecId = codecMeta.readUInt32BE(0);
    if (codecId !== SCRCPY_CODEC_ID_H264)
      throw new Error(`unexpected codec 0x${codecId.toString(16)}`);
    this.frameW = codecMeta.readUInt32BE(4);
    this.frameH = codecMeta.readUInt32BE(8);

    this.log.info({ deviceName, w: this.frameW, h: this.frameH }, 'scrcpy stream up');
    this.sink.status('streaming', `H.264 ${this.frameW}×${this.frameH}`);
    this.lastPacketAt = Date.now();
    void this.pump(reader);
    this.startWatchdog();
  }

  private async pump(reader: ByteReader): Promise<void> {
    try {
      for (;;) {
        const header = parseScrcpyPacketHeader(await reader.read(SCRCPY_PACKET_HEADER_SIZE));
        const payload = await reader.read(header.size);
        this.lastPacketAt = Date.now();
        if (header.config) {
          const sps = findSps(payload);
          if (sps) {
            this.frameW = sps.width;
            this.frameH = sps.height;
          }
          this.sink.sendFrame(
            encodeFrame({
              type: FrameType.VIDEO_CONFIG,
              codec: VideoCodec.H264,
              width: this.frameW,
              height: this.frameH,
              data: payload,
            }),
          );
          continue;
        }
        if (header.keyframe) this.checkSecure(payload.length);
        this.sink.sendFrame(
          encodeFrame({
            type: FrameType.VIDEO_FRAME,
            keyframe: header.keyframe,
            pts: header.pts,
            data: payload,
          }),
        );
      }
    } catch (err) {
      if (!this.stopped) {
        this.log.warn({ err: (err as Error).message }, 'scrcpy video stream ended');
        void this.restart('video stream ended');
      }
    }
  }

  private checkSecure(idrBytes: number): void {
    this.smallIdrs = idrBytes < SECURE_IDR_MAX_BYTES ? this.smallIdrs + 1 : 0;
    const suspected = this.smallIdrs >= 2;
    if (suspected !== this.secure) {
      this.secure = suspected;
      this.sink.status(
        'streaming',
        suspected ? 'Screen is black — app may set FLAG_SECURE' : undefined,
        suspected,
      );
    }
  }

  private startWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      const idle = Date.now() - this.lastPacketAt;
      // scrcpy only emits frames on change: probe a silent stream with RESET_VIDEO first.
      if (idle > STALL_PROBE_MS && Date.now() - this.resetSentAt > STALL_PROBE_MS) {
        this.resetSentAt = Date.now();
        this.sendControl(scrcpySimple(ScrcpyControlType.RESET_VIDEO));
      }
      if (idle > STALL_RESTART_MS) void this.restart('no frames for 8 s');
    }, 1000);
    this.watchdog.unref();
  }

  private restarting = false;
  private async restart(reason: string): Promise<void> {
    if (this.stopped || this.restarting) return;
    this.restarting = true;
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < 60_000);
    if (this.restarts.length >= 3) {
      this.sink.status('error', `stream keeps failing (${reason}); giving up`);
      this.restarting = false;
      await this.stop();
      return;
    }
    this.restarts.push(now);
    this.sink.status('restarting', reason);
    await this.teardown();
    try {
      await this.start();
    } catch (err) {
      this.sink.status('error', (err as Error).message);
    } finally {
      this.restarting = false;
    }
  }

  private sendControl(msg: Uint8Array): void {
    const s = this.controlSocket;
    if (s && !s.destroyed) s.write(msg);
  }

  handleInput(frame: Frame): void {
    const w = this.frameW;
    const h = this.frameH;
    if (!w || !h) return;
    switch (frame.type) {
      case FrameType.TOUCH:
        this.sendControl(
          scrcpyInjectTouch({
            action: frame.action,
            pointerId:
              frame.pointerId === 0
                ? SCRCPY_POINTER_ID_GENERIC_FINGER
                : SCRCPY_POINTER_ID_VIRTUAL_FINGER,
            x: denormalize(frame.x, w),
            y: denormalize(frame.y, h),
            screenW: w,
            screenH: h,
          }),
        );
        break;
      case FrameType.KEY: {
        const keycode = ANDROID_KEYCODES[frame.key];
        if (keycode !== undefined) {
          this.sendControl(
            scrcpyInjectKeycode(
              frame.action === KeyAction.DOWN ? KeyAction.DOWN : KeyAction.UP,
              keycode,
              0,
              androidMetaState(frame.meta),
            ),
          );
        }
        break;
      }
      case FrameType.TEXT:
        // INJECT_TEXT only handles characters in the device key map; paste anything else.
        if (/^[\x20-\x7e]*$/.test(frame.text))
          for (const m of scrcpyInjectText(frame.text)) this.sendControl(m);
        else this.sendControl(scrcpySetClipboard(frame.text, true));
        break;
      case FrameType.SCROLL:
        this.sendControl(
          scrcpyInjectScroll({
            x: denormalize(frame.x, w),
            y: denormalize(frame.y, h),
            screenW: w,
            screenH: h,
            hscroll: frame.dx,
            vscroll: frame.dy,
          }),
        );
        break;
      case FrameType.CLIPBOARD:
        this.sendControl(scrcpySetClipboard(frame.text, frame.paste));
        break;
      case FrameType.ROTATE:
        this.sendControl(scrcpySimple(ScrcpyControlType.ROTATE_DEVICE));
        break;
      default:
        break;
    }
  }

  requestKeyframe(): void {
    this.sendControl(scrcpySimple(ScrcpyControlType.RESET_VIDEO));
  }

  /** Clear the device clipboard (used by cleanup while a session is alive). */
  clearClipboard(): void {
    this.sendControl(scrcpySetClipboard('', false));
  }

  async setQuality(quality: StreamQuality): Promise<void> {
    // scrcpy cannot change encoder settings live; restart with the new ones.
    this.quality = quality;
    this.restarting = true; // keep the pump's error path from racing this restart
    try {
      await this.teardown();
      await this.start();
    } finally {
      this.restarting = false;
    }
  }

  private async teardown(): Promise<void> {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.videoSocket?.destroy();
    this.controlSocket?.destroy();
    this.serverProc?.end();
    this.videoSocket = null;
    this.controlSocket = null;
    this.serverProc = null;
    if (this.port) await this.adb.removeForward(this.serial, `tcp:${this.port}`);
    this.port = 0;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.teardown();
  }
}
