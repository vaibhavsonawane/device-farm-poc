/** Minimal H.264 Annex-B helpers: NAL splitting and SPS parsing (dimensions + codec string). */

export const NalType = {
  SLICE: 1,
  IDR: 5,
  SEI: 6,
  SPS: 7,
  PPS: 8,
  AUD: 9,
} as const;

export interface NalUnit {
  type: number;
  /** NAL payload without the start code. */
  data: Uint8Array;
}

/** Split an Annex-B byte stream on 0x000001 / 0x00000001 start codes. */
export function splitNalUnits(buf: Uint8Array): NalUnit[] {
  const units: NalUnit[] = [];
  let start = -1;
  let i = 0;
  const n = buf.byteLength;
  while (i + 2 < n) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        if (end > start && buf[end - 1] === 0) end--; // 4-byte start code
        if (end > start)
          units.push({ type: (buf[start] ?? 0) & 0x1f, data: buf.subarray(start, end) });
      }
      i += 3;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < n)
    units.push({ type: (buf[start] ?? 0) & 0x1f, data: buf.subarray(start) });
  return units;
}

export function containsNalType(buf: Uint8Array, type: number): boolean {
  return splitNalUnits(buf).some((u) => u.type === type);
}

/** Remove emulation-prevention bytes (0x000003 → 0x0000). */
export function nalToRbsp(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.byteLength);
  let o = 0;
  let zeros = 0;
  for (let i = 0; i < nal.byteLength; i++) {
    const b = nal[i] ?? 0;
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    out[o++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, o);
}

class BitReader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}
  bit(): number {
    const byte = this.buf[this.pos >> 3];
    if (byte === undefined) throw new Error('SPS: read past end');
    const v = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v >>> 0;
  }
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      zeros++;
      if (zeros > 31) throw new Error('SPS: bad exp-golomb');
    }
    return (2 ** zeros - 1 + this.bits(zeros)) >>> 0;
  }
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  }
}

export interface SpsInfo {
  profileIdc: number;
  constraintFlags: number;
  levelIdc: number;
  width: number;
  height: number;
}

function skipScalingList(r: BitReader, size: number): void {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

/** Parse an SPS NAL (without start code, including the 1-byte NAL header). */
export function parseSps(nal: Uint8Array): SpsInfo {
  const rbsp = nalToRbsp(nal.subarray(1));
  const r = new BitReader(rbsp);
  const profileIdc = r.bits(8);
  const constraintFlags = r.bits(8);
  const levelIdc = r.bits(8);
  r.ue(); // seq_parameter_set_id
  let chromaFormatIdc = 1;
  let separateColourPlane = 0;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
    chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) separateColourPlane = r.bit();
    r.ue(); // bit_depth_luma_minus8
    r.ue(); // bit_depth_chroma_minus8
    r.bit(); // qpprime_y_zero_transform_bypass_flag
    if (r.bit()) {
      const count = chromaFormatIdc !== 3 ? 8 : 12;
      for (let i = 0; i < count; i++) if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64);
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) {
    r.ue();
  } else if (pocType === 1) {
    r.bit();
    r.se();
    r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.bit(); // gaps_in_frame_num_value_allowed_flag
  const widthMbs = r.ue() + 1;
  const heightMapUnits = r.ue() + 1;
  const frameMbsOnly = r.bit();
  if (!frameMbsOnly) r.bit(); // mb_adaptive_frame_field_flag
  r.bit(); // direct_8x8_inference_flag
  let cropL = 0;
  let cropR = 0;
  let cropT = 0;
  let cropB = 0;
  if (r.bit()) {
    cropL = r.ue();
    cropR = r.ue();
    cropT = r.ue();
    cropB = r.ue();
  }
  const chromaArrayType = separateColourPlane ? 0 : chromaFormatIdc;
  const subW = chromaArrayType === 1 || chromaArrayType === 2 ? 2 : 1;
  const subH = chromaArrayType === 1 ? 2 : 1;
  const cropUnitX = chromaArrayType === 0 ? 1 : subW;
  const cropUnitY = (chromaArrayType === 0 ? 1 : subH) * (2 - frameMbsOnly);
  const width = widthMbs * 16 - cropUnitX * (cropL + cropR);
  const height = (2 - frameMbsOnly) * heightMapUnits * 16 - cropUnitY * (cropT + cropB);
  return { profileIdc, constraintFlags, levelIdc, width, height };
}

/** RFC 6381 codec string for WebCodecs, e.g. "avc1.42c01f". */
export function avcCodecString(
  sps: Pick<SpsInfo, 'profileIdc' | 'constraintFlags' | 'levelIdc'>,
): string {
  const hex = (v: number): string => v.toString(16).padStart(2, '0');
  return `avc1.${hex(sps.profileIdc)}${hex(sps.constraintFlags)}${hex(sps.levelIdc)}`;
}

/** Find and parse the first SPS in an Annex-B buffer. */
export function findSps(buf: Uint8Array): SpsInfo | null {
  const sps = splitNalUnits(buf).find((u) => u.type === NalType.SPS);
  if (!sps) return null;
  try {
    return parseSps(sps.data);
  } catch {
    return null;
  }
}

/** Concatenate byte arrays. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}
