/**
 * How the ScreenViewer reaches a device stream. Today frames are relayed by
 * the control server over a WebSocket; a WebRTC DataChannel transport
 * (portal ↔ agent) can implement the same interface later without UI changes.
 */
export interface StreamTransport {
  connect(): Promise<void>;
  send(frame: Uint8Array): void;
  onFrame(cb: (frame: Uint8Array) => void): void;
  /** Called once when the transport closes; `code` follows WebSocket close codes. */
  onClose(cb: (code: number, reason: string) => void): void;
  close(): void;
  readonly isOpen: boolean;
}

export class WsRelayTransport implements StreamTransport {
  private ws: WebSocket | null = null;
  private frameCb: ((f: Uint8Array) => void) | null = null;
  /** Frames that arrive before a handler is attached (e.g. the cached VIDEO_CONFIG sent on join). */
  private pending: Uint8Array[] = [];
  private closeCb: (code: number, reason: string) => void = () => undefined;

  constructor(private readonly url: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        resolve();
      };
      ws.onmessage = (e: MessageEvent) => {
        if (!(e.data instanceof ArrayBuffer)) return;
        const frame = new Uint8Array(e.data);
        if (this.frameCb) this.frameCb(frame);
        else if (this.pending.length < 300) this.pending.push(frame);
      };
      ws.onclose = (e) => {
        if (!opened) reject(new Error(`stream connection failed (${e.code})`));
        this.closeCb(e.code, e.reason);
      };
    });
  }

  send(frame: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame);
  }

  onFrame(cb: (frame: Uint8Array) => void): void {
    this.frameCb = cb;
    const queued = this.pending;
    this.pending = [];
    for (const f of queued) cb(f);
  }

  onClose(cb: (code: number, reason: string) => void): void {
    this.closeCb = cb;
  }

  close(): void {
    this.ws?.close(1000);
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

/** Build the absolute ws(s) URL for a stream path served by the current origin. */
export function streamUrl(path: string, ticket: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}?ticket=${encodeURIComponent(ticket)}`;
}
