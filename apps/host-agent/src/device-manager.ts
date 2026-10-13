import { FrameType, type Frame } from '@devicelab/protocol';
import type {
  AgentResult,
  AppInfo,
  CleanupCommand,
  DeviceHealth,
  DeviceReport,
  InstallCommand,
  InstallProgress,
  LogLine,
  SessionLogBatch,
  StreamQuality,
  StreamStartCommand,
  StreamStatus,
} from '@devicelab/shared-types';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type AgentConfig } from './config';
import { type DeviceDriver, type DriverEvents, type StreamHandle } from './drivers/driver';
import { type Logger } from './logger';
import { StreamLink } from './stream-link';

/** Outbound events the manager reports to the server (implemented by ServerLink). */
export interface ManagerOutbox {
  device(report: DeviceReport): void;
  removed(serial: string): void;
  health(h: DeviceHealth): void;
  log(batch: SessionLogBatch): void;
  streamStatus(s: StreamStatus): void;
  installProgress(p: InstallProgress): void;
}

interface ActiveStream {
  serial: string;
  link: StreamLink;
  handle: StreamHandle | null;
  lastKeyframeRequest: number;
}

function ok<T>(data: T): AgentResult<T> {
  return { ok: true, data } as AgentResult<T>;
}
function okVoid(): AgentResult {
  return { ok: true };
}
function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

/** Routes server commands to the driver that owns the device and manages per-session resources. */
export class DeviceManager {
  private readonly streams = new Map<string, ActiveStream>();
  private readonly logs = new Map<string, () => void>();
  private outbox: ManagerOutbox | null = null;
  private readonly known = new Map<string, DeviceReport>();

  constructor(
    private readonly cfg: AgentConfig,
    private readonly drivers: DeviceDriver[],
    private readonly log: Logger,
  ) {}

  get deviceCount(): number {
    return [...this.known.values()].filter((d) => d.state === 'online').length;
  }

  get activeStreams(): number {
    return this.streams.size;
  }

  devices(): DeviceReport[] {
    return [...this.known.values()];
  }

  async start(outbox: ManagerOutbox): Promise<void> {
    this.outbox = outbox;
    const allowed = new Set(this.cfg.allowedSerials);
    const events: DriverEvents = {
      onDevice: (r) => {
        if (allowed.size && !allowed.has(r.serial)) return;
        this.known.set(r.serial, r);
        this.outbox?.device(r);
      },
      onRemoved: (serial) => {
        if (!this.known.delete(serial)) return;
        this.outbox?.removed(serial);
        for (const [sid, s] of this.streams) if (s.serial === serial) void this.stopStream(sid);
      },
      onHealth: (h) => {
        if (allowed.size && !allowed.has(h.serial)) return;
        this.outbox?.health(h);
      },
    };
    for (const d of this.drivers) {
      try {
        await d.start(events);
        this.log.info({ driver: d.name }, 'driver started');
      } catch (err) {
        this.log.error({ driver: d.name, err: (err as Error).message }, 'driver failed to start');
      }
    }
  }

  async stop(): Promise<void> {
    for (const sid of [...this.streams.keys()]) await this.stopStream(sid);
    for (const stop of this.logs.values()) stop();
    this.logs.clear();
    for (const d of this.drivers) await d.stop().catch(() => undefined);
  }

  /** Re-report everything (after a reconnect or an admin re-sync). */
  async resync(): Promise<void> {
    for (const r of this.known.values()) this.outbox?.device(r);
    for (const d of this.drivers)
      await d.resync().catch((err: Error) => this.log.warn({ err: err.message }, 'resync failed'));
  }

  private driverFor(serial: string): DeviceDriver {
    const d = this.drivers.find((x) => x.owns(serial));
    if (!d) throw new Error(`device ${serial} is not attached to this host`);
    return d;
  }

  private streamUrl(streamPath: string): string {
    const base = new URL(this.cfg.serverUrl);
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    return new URL(streamPath, base).toString();
  }

  // ------------------------------------------------------------------ commands

  async startStream(cmd: StreamStartCommand): Promise<AgentResult> {
    try {
      const driver = this.driverFor(cmd.serial);
      await this.stopStream(cmd.sessionId);
      for (const [sid, s] of this.streams) if (s.serial === cmd.serial) await this.stopStream(sid);

      const status = (state: StreamStatus['state'], message?: string, secure?: boolean): void =>
        this.outbox?.streamStatus({
          sessionId: cmd.sessionId,
          state,
          message,
          secureContentSuspected: secure,
        });
      const link = new StreamLink(
        this.streamUrl(cmd.streamPath),
        this.log.child({ session: cmd.sessionId }),
        { ca: this.cfg.ca },
      );
      const active: ActiveStream = {
        serial: cmd.serial,
        link,
        handle: null,
        lastKeyframeRequest: 0,
      };
      this.streams.set(cmd.sessionId, active);

      link.onInput = (frame: Frame) => active.handle?.handleInput(frame);
      link.onKeyframeRequest = () => {
        const now = Date.now();
        if (now - active.lastKeyframeRequest < 500) return;
        active.lastKeyframeRequest = now;
        active.handle?.requestKeyframe();
      };
      await link.connect();
      status('starting');
      active.handle = await driver.startStream(cmd.serial, cmd.quality, {
        sendFrame: (frame) => {
          const type = frame[1];
          const isVideo = type === FrameType.VIDEO_FRAME || type === FrameType.MJPEG_FRAME;
          const keyframe =
            type === FrameType.VIDEO_FRAME
              ? ((frame[2] ?? 0) & 1) === 1
              : type === FrameType.MJPEG_FRAME;
          link.send(frame, { droppable: isVideo, keyframe });
        },
        status,
      });
      this.log.info({ session: cmd.sessionId, serial: cmd.serial }, 'stream started');
      return okVoid();
    } catch (err) {
      this.log.error(
        { session: cmd.sessionId, err: (err as Error).message },
        'stream start failed',
      );
      await this.stopStream(cmd.sessionId);
      return fail(err);
    }
  }

  async stopStream(sessionId: string): Promise<AgentResult> {
    const s = this.streams.get(sessionId);
    if (!s) return okVoid();
    this.streams.delete(sessionId);
    s.link.close();
    await s.handle?.stop().catch(() => undefined);
    this.outbox?.streamStatus({ sessionId, state: 'stopped' });
    this.log.info({ session: sessionId }, 'stream stopped');
    return okVoid();
  }

  async setQuality(sessionId: string, quality: StreamQuality): Promise<AgentResult> {
    const s = this.streams.get(sessionId);
    if (!s?.handle) return fail('stream not running');
    try {
      await s.handle.setQuality(quality);
      return okVoid();
    } catch (err) {
      return fail(err);
    }
  }

  async install(cmd: InstallCommand): Promise<AgentResult<{ packageIds: string[] }>> {
    const progress = (percent: number, state: InstallProgress['state'], message?: string): void =>
      this.outbox?.installProgress({
        jobId: cmd.jobId,
        serial: cmd.serial,
        percent: Math.round(percent),
        state,
        message,
      });
    const dir = await mkdtemp(path.join(os.tmpdir(), 'devicelab-'));
    try {
      const driver = this.driverFor(cmd.serial);
      const file = path.join(dir, path.basename(cmd.fileName).replace(/[^\w.-]+/g, '_'));
      progress(0, 'downloading');
      await this.download(cmd.downloadPath, file, cmd.checksumSha256, (p) =>
        progress(p * 0.5, 'downloading'),
      );
      progress(50, 'installing');
      const packageIds = await driver.install(cmd.serial, file, (p, msg) =>
        progress(50 + p * 0.5, 'installing', msg),
      );
      progress(100, 'done', packageIds.join(', '));
      return ok({ packageIds });
    } catch (err) {
      progress(100, 'error', (err as Error).message);
      return fail(err);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Download a build from the server and verify its SHA-256 before installing it. */
  private async download(
    downloadPath: string,
    dest: string,
    sha256: string,
    onProgress: (fraction100: number) => void,
  ): Promise<void> {
    const url = new URL(downloadPath, this.cfg.serverUrl);
    const res = await fetch(url, { headers: { Authorization: `Agent ${this.cfg.agentToken}` } });
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length') ?? 0);
    let received = 0;
    let lastReport = 0;
    const hash = createHash('sha256');
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        hash.update(chunk);
        const now = Date.now();
        if (total && now - lastReport > 250) {
          lastReport = now;
          onProgress((received / total) * 100);
        }
        cb(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
      meter,
      createWriteStream(dest),
    );
    const digest = hash.digest('hex');
    if (digest !== sha256)
      throw new Error(
        `checksum mismatch (expected ${sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…)`,
      );
  }

  async listApps(serial: string): Promise<AgentResult<AppInfo[]>> {
    try {
      return ok(await this.driverFor(serial).listApps(serial));
    } catch (err) {
      return fail(err);
    }
  }

  async appAction(
    serial: string,
    packageId: string,
    action: 'launch' | 'stop' | 'clear' | 'uninstall',
  ): Promise<AgentResult> {
    try {
      if (!/^[a-zA-Z0-9._-]+$/.test(packageId)) throw new Error('invalid package id');
      await this.driverFor(serial).appAction(serial, packageId, action);
      return okVoid();
    } catch (err) {
      return fail(err);
    }
  }

  async screenshot(serial: string): Promise<AgentResult<{ png: Uint8Array }>> {
    try {
      return ok({ png: await this.driverFor(serial).screenshot(serial) });
    } catch (err) {
      return fail(err);
    }
  }

  async logsControl(
    serial: string,
    sessionId: string,
    action: 'start' | 'stop',
  ): Promise<AgentResult> {
    try {
      if (action === 'stop') {
        this.logs.get(sessionId)?.();
        this.logs.delete(sessionId);
        return okVoid();
      }
      if (this.logs.has(sessionId)) return okVoid();
      let buffer: LogLine[] = [];
      const flush = (): void => {
        if (!buffer.length) return;
        for (let i = 0; i < buffer.length; i += 1000) {
          this.outbox?.log({ sessionId, lines: buffer.slice(i, i + 1000) });
        }
        buffer = [];
      };
      const timer = setInterval(flush, 250);
      const stopDriver = await this.driverFor(serial).startLogs(serial, (lines) => {
        buffer.push(...lines);
        if (buffer.length >= 1000) flush();
      });
      this.logs.set(sessionId, () => {
        clearInterval(timer);
        flush();
        stopDriver();
      });
      return okVoid();
    } catch (err) {
      return fail(err);
    }
  }

  async cleanup(cmd: CleanupCommand): Promise<AgentResult> {
    try {
      for (const [sid, s] of this.streams) if (s.serial === cmd.serial) await this.stopStream(sid);
      if (cmd.sessionId) await this.logsControl(cmd.serial, cmd.sessionId, 'stop');
      await this.driverFor(cmd.serial).cleanup(cmd.serial, {
        uninstallPackages: cmd.uninstallPackages,
        reboot: cmd.reboot,
      });
      this.log.info({ serial: cmd.serial, removed: cmd.uninstallPackages }, 'cleanup done');
      return okVoid();
    } catch (err) {
      this.log.error({ serial: cmd.serial, err: (err as Error).message }, 'cleanup failed');
      return fail(err);
    }
  }

  async reboot(serial: string): Promise<AgentResult> {
    try {
      await this.driverFor(serial).reboot(serial);
      return okVoid();
    } catch (err) {
      return fail(err);
    }
  }
}
