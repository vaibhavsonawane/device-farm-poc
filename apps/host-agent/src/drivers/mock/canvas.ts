import { deflateSync } from 'node:zlib';
import { FONT_H, FONT_W, glyph } from './font';

export type RGB = readonly [number, number, number];

/** Minimal RGBA software canvas used to draw the mock device screens. */
export class Canvas {
  readonly data: Buffer;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = Buffer.alloc(width * height * 4);
  }

  fill([r, g, b]: RGB): void {
    const px = Buffer.from([r, g, b, 255]);
    this.data.fill(px);
  }

  copyFrom(other: Canvas): void {
    other.data.copy(this.data);
  }

  rect(x: number, y: number, w: number, h: number, [r, g, b]: RGB, alpha = 1): void {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.floor(x + w));
    const y1 = Math.min(this.height, Math.floor(y + h));
    if (x1 <= x0 || y1 <= y0) return;
    const d = this.data;
    if (alpha >= 1) {
      const row = Buffer.alloc((x1 - x0) * 4);
      for (let i = 0; i < row.length; i += 4) {
        row[i] = r;
        row[i + 1] = g;
        row[i + 2] = b;
        row[i + 3] = 255;
      }
      for (let yy = y0; yy < y1; yy++) row.copy(d, (yy * this.width + x0) * 4);
      return;
    }
    const a = Math.max(0, alpha);
    for (let yy = y0; yy < y1; yy++) {
      let o = (yy * this.width + x0) * 4;
      for (let xx = x0; xx < x1; xx++, o += 4) {
        d[o] = d[o]! + (r - d[o]!) * a;
        d[o + 1] = d[o + 1]! + (g - d[o + 1]!) * a;
        d[o + 2] = d[o + 2]! + (b - d[o + 2]!) * a;
      }
    }
  }

  roundRect(x: number, y: number, w: number, h: number, radius: number, color: RGB): void {
    const r = Math.min(radius, w / 2, h / 2);
    this.rect(x + r, y, w - 2 * r, h, color);
    this.rect(x, y + r, r, h - 2 * r, color);
    this.rect(x + w - r, y + r, r, h - 2 * r, color);
    this.circle(x + r, y + r, r, color);
    this.circle(x + w - r, y + r, r, color);
    this.circle(x + r, y + h - r, r, color);
    this.circle(x + w - r, y + h - r, r, color);
  }

  circle(cx: number, cy: number, radius: number, [r, g, b]: RGB, alpha = 1): void {
    const r2 = radius * radius;
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + radius));
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      const span = Math.sqrt(Math.max(0, r2 - dy * dy));
      const x0 = Math.max(0, Math.floor(cx - span));
      const x1 = Math.min(this.width - 1, Math.ceil(cx + span));
      let o = (y * this.width + x0) * 4;
      for (let x = x0; x <= x1; x++, o += 4) {
        this.data[o] = this.data[o]! + (r - this.data[o]!) * alpha;
        this.data[o + 1] = this.data[o + 1]! + (g - this.data[o + 1]!) * alpha;
        this.data[o + 2] = this.data[o + 2]! + (b - this.data[o + 2]!) * alpha;
      }
    }
  }

  /** Bitmap text; `scale` multiplies the 8×13 glyph size. Returns the drawn width. */
  text(str: string, x: number, y: number, color: RGB, scale = 1): number {
    let cx = Math.round(x);
    const top = Math.round(y);
    for (const ch of str) {
      const rows = glyph(ch);
      for (let gy = 0; gy < FONT_H; gy++) {
        const bits = rows[gy] ?? 0;
        if (!bits) continue;
        for (let gx = 0; gx < FONT_W; gx++) {
          if (bits & (0x80 >> gx))
            this.rect(cx + gx * scale, top + gy * scale, scale, scale, color);
        }
      }
      cx += FONT_W * scale;
    }
    return cx - x;
  }

  textCentered(str: string, cx: number, y: number, color: RGB, scale = 1): void {
    this.text(str, cx - (str.length * FONT_W * scale) / 2, y, color, scale);
  }

  toPng(): Buffer {
    return encodePng(this.width, this.height, this.data);
  }
}

// ------------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tb));
  return Buffer.concat([len, tb, crc]);
}

/** Encode RGBA pixels as a PNG (no external dependencies). */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
