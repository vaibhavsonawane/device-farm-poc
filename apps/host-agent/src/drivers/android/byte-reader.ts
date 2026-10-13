import { type Socket } from 'node:net';

/** Exact-length async reads from a TCP socket (used for the scrcpy video protocol). */
export class ByteReader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private waiter: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null =
    null;
  private ended: Error | null = null;

  constructor(socket: Socket) {
    socket.on('data', (d: Buffer) => {
      this.chunks.push(d);
      this.buffered += d.length;
      this.drain();
    });
    const end = (err?: Error): void => {
      this.ended = err ?? new Error('socket closed');
      if (this.waiter) {
        this.waiter.reject(this.ended);
        this.waiter = null;
      }
    };
    socket.on('end', () => end());
    socket.on('close', () => end());
    socket.on('error', (e) => end(e));
  }

  private take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    let o = 0;
    while (o < n) {
      const c = this.chunks[0]!;
      const need = n - o;
      if (c.length <= need) {
        c.copy(out, o);
        o += c.length;
        this.chunks.shift();
      } else {
        c.copy(out, o, 0, need);
        this.chunks[0] = c.subarray(need);
        o += need;
      }
    }
    this.buffered -= n;
    return out;
  }

  private drain(): void {
    if (this.waiter && this.buffered >= this.waiter.n) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve(this.take(w.n));
    }
  }

  read(n: number): Promise<Buffer> {
    if (this.waiter) return Promise.reject(new Error('concurrent read'));
    if (this.buffered >= n) return Promise.resolve(this.take(n));
    if (this.ended) return Promise.reject(this.ended);
    return new Promise((resolve, reject) => {
      this.waiter = { n, resolve, reject };
    });
  }
}
