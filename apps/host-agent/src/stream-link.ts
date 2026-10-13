import {
  FrameType,
  decodeFrame,
  encodeFrame,
  peekFrameType,
  type Frame,
} from '@devicelab/protocol';
import WebSocket from 'ws';
import { type Logger } from './logger';

/** Above this the server can't keep up: drop delta frames until the next keyframe. */
const HIGH_WATER = 4 * 1024 * 1024;

/**
 * Binary WebSocket from the agent to the server for one session. Video goes up,
 * input comes down. PINGs are answered here so the portal measures the real
 * portal↔agent round trip.
 */
export class StreamLink {
  private ws: WebSocket | null = null;
  private closed = false;
  private dropping = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempts = 0;
  onInput: (frame: Frame) => void = () => undefined;
  onKeyframeRequest: () => void = () => undefined;
  onOpen: () => void = () => undefined;

  constructor(
    private readonly url: string,
    private readonly log: Logger,
    private readonly tls: { ca?: Buffer },
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, {
        ca: this.tls.ca,
        perMessageDeflate: false,
        handshakeTimeout: 10_000,
      });
      ws.binaryType = 'nodebuffer';
      this.ws = ws;
      let opened = false;
      ws.on('open', () => {
        opened = true;
        this.attempts = 0;
        this.onOpen();
        resolve();
      });
      ws.on('message', (data, isBinary) => {
        if (isBinary) this.handle(data as Buffer);
      });
      ws.on('close', (code) => {
        if (!opened) return reject(new Error(`stream socket closed during handshake (${code})`));
        if (this.closed) return;
        // 4000 = session ended, 4009 = replaced, 410 never opens: don't reconnect.
        if (code === 4000 || code === 4009 || code === 1000) {
          this.closed = true;
          return;
        }
        this.scheduleReconnect();
      });
      ws.on('error', (err) => {
        this.log.warn({ err: err.message }, 'stream socket error');
        if (!opened) reject(err);
      });
      ws.on('unexpected-response', (_req, res) =>
        reject(new Error(`stream socket rejected: HTTP ${res.statusCode}`)),
      );
    });
  }

  private scheduleReconnect(): void {
    const delay = Math.min(10_000, 500 * 2 ** this.attempts++);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err: Error) => {
        this.log.warn({ err: err.message }, 'stream reconnect failed');
        if (!this.closed && this.attempts < 8) this.scheduleReconnect();
      });
    }, delay);
  }

  private handle(buf: Buffer): void {
    const type = peekFrameType(buf);
    if (type === FrameType.PING) {
      const ping = decodeFrame(buf);
      if (ping.type === FrameType.PING)
        this.ws?.send(encodeFrame({ type: FrameType.PONG, seq: ping.seq, t: ping.t }));
      return;
    }
    if (type === FrameType.REQUEST_KEYFRAME) {
      this.onKeyframeRequest();
      return;
    }
    try {
      this.onInput(decodeFrame(buf));
    } catch (err) {
      this.log.debug({ err: (err as Error).message }, 'bad input frame');
    }
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Send a frame; returns false if it was dropped for backpressure. */
  send(frame: Uint8Array, opts: { keyframe?: boolean; droppable?: boolean } = {}): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    if (opts.droppable) {
      if (ws.bufferedAmount > HIGH_WATER) {
        if (!this.dropping) setTimeout(() => this.onKeyframeRequest(), 250);
        this.dropping = true;
        return false;
      }
      if (this.dropping && !opts.keyframe) return false;
      if (opts.keyframe) this.dropping = false;
    }
    ws.send(frame);
    return true;
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close(1000, 'stream stopped');
  }
}
