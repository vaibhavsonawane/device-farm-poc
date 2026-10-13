import {
  FrameType,
  NalType,
  VideoCodec,
  concatBytes,
  encodeFrame,
  findSps,
  splitNalUnits,
} from '@devicelab/protocol';
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import jpeg from 'jpeg-js';
import { type Canvas } from './canvas';

export interface FrameEncoder {
  /** Feed a rendered frame. */
  push(canvas: Canvas): void;
  requestKeyframe(): void;
  close(): void;
}

let ffmpegAvailable: boolean | null = null;

export function hasFfmpeg(): boolean {
  if (ffmpegAvailable === null) {
    try {
      ffmpegAvailable =
        spawnSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore', timeout: 5000 })
          .status === 0;
    } catch {
      ffmpegAvailable = false;
    }
  }
  return ffmpegAvailable;
}

const START_CODE = Uint8Array.of(0, 0, 0, 1);

/**
 * Real H.264 (Annex-B, baseline) from raw RGBA frames via ffmpeg/libx264 with
 * zero-latency tuning. Access units are delimited by AUD NALs.
 */
export class H264Encoder implements FrameEncoder {
  private proc: ChildProcessWithoutNullStreams;
  private pending = Buffer.alloc(0);
  private configKey = '';
  private closed = false;

  constructor(
    private readonly width: number,
    private readonly height: number,
    fps: number,
    bitRate: number,
    private readonly emit: (frame: Uint8Array) => void,
    onError: (msg: string) => void,
  ) {
    this.proc = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        '-s',
        `${width}x${height}`,
        '-r',
        String(fps),
        '-i',
        'pipe:0',
        '-an',
        '-vf',
        'format=yuv420p',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-tune',
        'zerolatency',
        '-profile:v',
        'baseline',
        '-g',
        String(fps),
        '-keyint_min',
        String(fps),
        '-sc_threshold',
        '0',
        '-b:v',
        String(bitRate),
        '-maxrate',
        String(bitRate),
        '-bufsize',
        String(Math.round(bitRate / 2)),
        '-x264-params',
        'repeat-headers=1:aud=1',
        '-flush_packets',
        '1',
        '-f',
        'h264',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr.on('data', (d: Buffer) => onError(d.toString().trim()));
    this.proc.stdin.on('error', () => undefined);
    this.proc.on('exit', (code) => {
      if (!this.closed && code !== 0) onError(`ffmpeg exited with code ${code}`);
    });
  }

  private onData(chunk: Buffer): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    // Find AUD start codes; everything between two AUDs is one access unit.
    const starts: number[] = [];
    const buf = this.pending;
    for (let i = 0; i + 4 < buf.length; i++) {
      if (
        buf[i] === 0 &&
        buf[i + 1] === 0 &&
        buf[i + 2] === 1 &&
        ((buf[i + 3] ?? 0) & 0x1f) === NalType.AUD
      ) {
        starts.push(i > 0 && buf[i - 1] === 0 ? i - 1 : i);
      }
    }
    if (starts.length < 2) return;
    for (let k = 0; k < starts.length - 1; k++)
      this.emitAccessUnit(buf.subarray(starts[k], starts[k + 1]));
    this.pending = Buffer.from(buf.subarray(starts[starts.length - 1]));
  }

  private emitAccessUnit(au: Buffer): void {
    const nals = splitNalUnits(au).filter((n) => n.type !== NalType.AUD);
    if (!nals.length) return;
    const sps = nals.find((n) => n.type === NalType.SPS);
    const pps = nals.find((n) => n.type === NalType.PPS);
    const keyframe = nals.some((n) => n.type === NalType.IDR);
    if (sps && pps) {
      const config = concatBytes(START_CODE, sps.data, START_CODE, pps.data);
      const key = Buffer.from(config).toString('base64');
      if (key !== this.configKey) {
        this.configKey = key;
        const info = findSps(config);
        this.emit(
          encodeFrame({
            type: FrameType.VIDEO_CONFIG,
            codec: VideoCodec.H264,
            width: info?.width ?? this.width,
            height: info?.height ?? this.height,
            data: config,
          }),
        );
      }
    }
    const data = concatBytes(...nals.flatMap((n) => [START_CODE, n.data]));
    this.emit(
      encodeFrame({ type: FrameType.VIDEO_FRAME, keyframe, pts: BigInt(Date.now()) * 1000n, data }),
    );
  }

  push(canvas: Canvas): void {
    if (this.closed || canvas.width !== this.width || canvas.height !== this.height) return;
    // Drop frames if ffmpeg is behind rather than queueing latency.
    if (this.proc.stdin.writableLength > canvas.data.length * 2) return;
    this.proc.stdin.write(Buffer.from(canvas.data));
  }

  /** x264 emits an IDR every second (GOP = fps), which bounds join latency. */
  requestKeyframe(): void {}

  close(): void {
    this.closed = true;
    this.proc.stdin.end();
    this.proc.kill('SIGTERM');
  }
}

/** MJPEG frames (what iOS/WDA produces; also the fallback when ffmpeg is missing). */
export class MjpegEncoder implements FrameEncoder {
  constructor(
    private readonly quality: number,
    private readonly emit: (frame: Uint8Array) => void,
  ) {}

  push(canvas: Canvas): void {
    const { data } = jpeg.encode(
      { data: canvas.data, width: canvas.width, height: canvas.height },
      this.quality,
    );
    this.emit(
      encodeFrame({
        type: FrameType.MJPEG_FRAME,
        width: canvas.width,
        height: canvas.height,
        data,
      }),
    );
  }

  requestKeyframe(): void {}

  close(): void {}
}
