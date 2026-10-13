import { type Frame, FrameType, avcCodecString, concatBytes, findSps } from '@devicelab/protocol';
import JMuxer from 'jmuxer';

export type DecoderKind = 'webcodecs' | 'jmuxer' | 'mjpeg';

export interface RendererStats {
  fps: number;
  width: number;
  height: number;
  decoder: DecoderKind | null;
  dropped: number;
  /** Set when this browser cannot decode the stream at all. */
  error: string | null;
}

const H264_UNSUPPORTED =
  'This browser cannot decode H.264 (WebCodecs/MSE). Use a current Chrome, Edge or Safari build with proprietary codecs.';

function mseH264Supported(): boolean {
  return (
    typeof MediaSource !== 'undefined' &&
    MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')
  );
}

export function webCodecsAvailable(): boolean {
  return typeof window !== 'undefined' && 'VideoDecoder' in window && 'EncodedVideoChunk' in window;
}

/**
 * Turns protocol frames into pixels. H.264 → WebCodecs VideoDecoder (low
 * latency, hardware where available) with JMuxer/MSE as fallback; MJPEG →
 * createImageBitmap. Framework-agnostic so it can be unit-tested and reused.
 */
export class ScreenRenderer {
  private ctx: CanvasRenderingContext2D | null;
  private decoder: VideoDecoder | null = null;
  private jmuxer: JMuxer | null = null;
  private config: Uint8Array | null = null;
  private waitKey = true;
  private mode: DecoderKind | null = null;
  private frames = 0;
  private dropped = 0;
  private fpsTimer: ReturnType<typeof setInterval>;
  private mjpegBusy = false;
  private mjpegPending: Uint8Array | null = null;
  private destroyed = false;
  stats: RendererStats = { fps: 0, width: 0, height: 0, decoder: null, dropped: 0, error: null };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly video: HTMLVideoElement,
    private readonly onChange: (stats: RendererStats) => void,
    private readonly forceFallback = false,
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.fpsTimer = setInterval(() => {
      this.stats = { ...this.stats, fps: this.frames, dropped: this.dropped };
      this.frames = 0;
      this.onChange(this.stats);
    }, 1000);
  }

  private setSize(width: number, height: number): void {
    if (width === this.stats.width && height === this.stats.height) return;
    if (this.mode !== 'jmuxer') {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.stats = { ...this.stats, width, height };
    this.onChange(this.stats);
  }

  private setMode(mode: DecoderKind): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.canvas.style.display = mode === 'jmuxer' ? 'none' : 'block';
    this.video.style.display = mode === 'jmuxer' ? 'block' : 'none';
    this.stats = { ...this.stats, decoder: mode };
    this.onChange(this.stats);
  }

  handle(frame: Frame): void {
    if (this.destroyed) return;
    switch (frame.type) {
      case FrameType.VIDEO_CONFIG:
        this.onConfig(frame.data, frame.width, frame.height);
        break;
      case FrameType.VIDEO_FRAME:
        this.onVideo(frame.data, frame.keyframe);
        break;
      case FrameType.MJPEG_FRAME:
        this.setMode('mjpeg');
        this.onMjpeg(frame.data);
        break;
      default:
        break;
    }
  }

  private onConfig(data: Uint8Array, width: number, height: number): void {
    this.config = data.slice();
    this.waitKey = true;
    const sps = findSps(data);
    if (sps) this.setSize(sps.width, sps.height);
    else if (width && height) this.setSize(width, height);

    if (webCodecsAvailable() && !this.forceFallback && this.mode !== 'jmuxer') {
      try {
        this.ensureDecoder();
        this.decoder!.configure({
          codec: sps ? avcCodecString(sps) : 'avc1.42e01f',
          optimizeForLatency: true,
          hardwareAcceleration: 'no-preference',
        });
        this.setMode('webcodecs');
        return;
      } catch {
        // fall through to JMuxer
      }
    }
    this.startJmuxer();
  }

  private ensureDecoder(): void {
    if (this.decoder && this.decoder.state !== 'closed') return;
    this.decoder = new VideoDecoder({
      output: (vf) => {
        if (vf.displayWidth !== this.stats.width || vf.displayHeight !== this.stats.height)
          this.setSize(vf.displayWidth, vf.displayHeight);
        this.ctx?.drawImage(vf, 0, 0, this.canvas.width, this.canvas.height);
        vf.close();
        this.frames++;
      },
      error: () => {
        // Unsupported profile or corrupt data: switch to the MSE fallback for the rest of the session.
        this.decoder = null;
        this.startJmuxer();
      },
    });
  }

  private startJmuxer(): void {
    if (this.jmuxer) return;
    try {
      this.decoder?.close();
    } catch {
      /* already closed */
    }
    this.decoder = null;
    if (!mseH264Supported()) {
      this.stats = { ...this.stats, error: H264_UNSUPPORTED };
      this.onChange(this.stats);
      return;
    }
    this.setMode('jmuxer');
    this.jmuxer = new JMuxer({
      node: this.video,
      mode: 'video',
      flushingTime: 0,
      fps: 60,
      debug: false,
    });
    this.waitKey = true;
    this.video.play().catch(() => undefined);
  }

  private onVideo(data: Uint8Array, keyframe: boolean): void {
    if (this.waitKey && !keyframe) {
      this.dropped++;
      return;
    }
    // Chrome's Annex-B path needs SPS/PPS in-band on every keyframe.
    const payload = keyframe && this.config ? concatBytes(this.config, data) : data;
    if (this.mode === 'jmuxer' && this.jmuxer) {
      this.jmuxer.feed({ video: payload });
      this.waitKey = false;
      this.frames++;
      return;
    }
    const dec = this.decoder;
    if (!dec || dec.state !== 'configured') return;
    if (!keyframe && dec.decodeQueueSize > 30) {
      this.dropped++;
      this.waitKey = true;
      return;
    }
    try {
      dec.decode(
        new EncodedVideoChunk({
          type: keyframe ? 'key' : 'delta',
          timestamp: Math.round(performance.now() * 1000),
          data: payload,
        }),
      );
      this.waitKey = false;
    } catch {
      this.waitKey = true;
    }
  }

  private onMjpeg(data: Uint8Array): void {
    if (this.mjpegBusy) {
      this.mjpegPending = data; // latest wins
      return;
    }
    this.mjpegBusy = true;
    createImageBitmap(new Blob([data as BlobPart], { type: 'image/jpeg' }))
      .then((bmp) => {
        if (!this.destroyed) {
          this.setSize(bmp.width, bmp.height);
          this.ctx?.drawImage(bmp, 0, 0);
          this.frames++;
        }
        bmp.close();
      })
      .catch(() => {
        this.dropped++;
      })
      .finally(() => {
        this.mjpegBusy = false;
        const next = this.mjpegPending;
        this.mjpegPending = null;
        if (next) this.onMjpeg(next);
      });
  }

  /** Current frame as a PNG data URL (client-side snapshot). */
  snapshot(): string {
    return this.canvas.toDataURL('image/png');
  }

  destroy(): void {
    this.destroyed = true;
    clearInterval(this.fpsTimer);
    try {
      this.decoder?.close();
    } catch {
      /* already closed */
    }
    this.jmuxer?.destroy();
  }
}
