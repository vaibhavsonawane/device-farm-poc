import { describe, expect, it } from 'vitest';
import {
  DeviceKey,
  FrameType,
  type Frame,
  KeyAction,
  NORM_MAX,
  ProtocolError,
  TouchAction,
  VideoCodec,
  decodeFrame,
  denormalize,
  encodeFrame,
  normalize,
  peekFrameType,
} from './frames';
import {
  ANDROID_KEYCODES,
  SCRCPY_POINTER_ID_GENERIC_FINGER,
  ScrcpyControlType,
  parseScrcpyPacketHeader,
  scrcpyInjectKeycode,
  scrcpyInjectScroll,
  scrcpyInjectText,
  scrcpyInjectTouch,
  scrcpyServerArgs,
  scrcpySetClipboard,
} from './scrcpy';
import { NalType, avcCodecString, findSps, parseSps, splitNalUnits } from './h264';

const hex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));

describe('frame encode/decode round trip', () => {
  const cases: Frame[] = [
    {
      type: FrameType.VIDEO_CONFIG,
      codec: VideoCodec.H264,
      width: 720,
      height: 1280,
      data: Uint8Array.of(0, 0, 0, 1, 0x67),
    },
    {
      type: FrameType.VIDEO_FRAME,
      keyframe: true,
      pts: 123_456_789_012n,
      data: Uint8Array.of(0, 0, 1, 0x65, 9),
    },
    { type: FrameType.VIDEO_FRAME, keyframe: false, pts: 0n, data: new Uint8Array(0) },
    {
      type: FrameType.MJPEG_FRAME,
      width: 390,
      height: 844,
      data: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
    },
    { type: FrameType.PING, seq: 42, t: 1_700_000_000_123 },
    { type: FrameType.PONG, seq: 0xffffffff, t: 5 },
    { type: FrameType.TOUCH, action: TouchAction.MOVE, pointerId: 1, x: 12345, y: NORM_MAX },
    { type: FrameType.KEY, action: KeyAction.DOWN, key: DeviceKey.HOME, meta: 3 },
    { type: FrameType.TEXT, text: 'नमस्ते UPI ₹100 😀' },
    { type: FrameType.SCROLL, x: 100, y: 200, dx: -1.5, dy: 3 },
    { type: FrameType.CLIPBOARD, paste: true, text: 'otp 123456' },
    { type: FrameType.ROTATE },
    { type: FrameType.REQUEST_KEYFRAME },
  ];

  for (const frame of cases) {
    it(`round-trips type 0x${frame.type.toString(16)}`, () => {
      const bytes = encodeFrame(frame);
      expect(peekFrameType(bytes)).toBe(frame.type);
      expect(decodeFrame(bytes)).toEqual(frame);
      // Also accepts an ArrayBuffer (what browsers deliver).
      expect(decodeFrame(bytes.slice().buffer)).toEqual(frame);
    });
  }

  it('clamps out-of-range coordinates instead of wrapping', () => {
    const f = decodeFrame(
      encodeFrame({ type: FrameType.TOUCH, action: TouchAction.DOWN, pointerId: 0, x: -5, y: 1e9 }),
    );
    expect(f).toMatchObject({ x: 0, y: NORM_MAX });
  });

  it('rejects malformed frames', () => {
    expect(() => decodeFrame(Uint8Array.of(1, 2))).toThrow(ProtocolError);
    expect(() => decodeFrame(Uint8Array.of(9, FrameType.TOUCH, 0, 0, 0, 0, 0, 0, 0, 0))).toThrow(
      /version/,
    );
    expect(() => decodeFrame(Uint8Array.of(1, 0x7f, 0, 0))).toThrow(/unknown frame type/);
    expect(() => decodeFrame(Uint8Array.of(1, FrameType.TOUCH, 0, 0, 0))).toThrow(/truncated/);
    expect(() => decodeFrame(Uint8Array.of(1, FrameType.TOUCH, 0, 0, 9, 0, 0, 0, 0, 0))).toThrow(
      /touch action/,
    );
    expect(peekFrameType(Uint8Array.of(2, 1, 0, 0))).toBeNull();
  });

  it('maps normalised coordinates onto pixels', () => {
    expect(denormalize(0, 1080)).toBe(0);
    expect(denormalize(NORM_MAX, 1080)).toBe(1079);
    expect(denormalize(NORM_MAX / 2, 1081)).toBe(540);
    expect(normalize(1079, 1080)).toBe(NORM_MAX);
    expect(denormalize(normalize(333, 720), 720)).toBe(333);
  });
});

describe('scrcpy control messages', () => {
  it('encodes a keycode event (14 bytes)', () => {
    const b = scrcpyInjectKeycode(KeyAction.UP, ANDROID_KEYCODES[DeviceKey.BACK], 0, 0x1000);
    expect(b.byteLength).toBe(14);
    expect([...b]).toEqual([0, 1, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0x10, 0]);
  });

  it('encodes a touch event (32 bytes)', () => {
    const b = scrcpyInjectTouch({
      action: TouchAction.DOWN,
      pointerId: SCRCPY_POINTER_ID_GENERIC_FINGER,
      x: 100,
      y: 200,
      screenW: 720,
      screenH: 1280,
    });
    const v = new DataView(b.buffer);
    expect(b.byteLength).toBe(32);
    expect(v.getUint8(0)).toBe(ScrcpyControlType.INJECT_TOUCH_EVENT);
    expect(v.getUint8(1)).toBe(0);
    expect(v.getBigInt64(2)).toBe(-2n);
    expect(v.getInt32(10)).toBe(100);
    expect(v.getInt32(14)).toBe(200);
    expect(v.getUint16(18)).toBe(720);
    expect(v.getUint16(20)).toBe(1280);
    expect(v.getUint16(22)).toBe(0xffff);
  });

  it('encodes scroll with i16 fixed point of value/16', () => {
    const b = scrcpyInjectScroll({ x: 1, y: 2, screenW: 10, screenH: 20, hscroll: 0, vscroll: 8 });
    const v = new DataView(b.buffer);
    expect(b.byteLength).toBe(21);
    expect(v.getInt16(13)).toBe(0);
    expect(v.getInt16(15)).toBe(0x4000);
    const max = scrcpyInjectScroll({
      x: 1,
      y: 2,
      screenW: 10,
      screenH: 20,
      hscroll: -99,
      vscroll: 99,
    });
    expect(new DataView(max.buffer).getInt16(13)).toBe(-0x8000);
    expect(new DataView(max.buffer).getInt16(15)).toBe(0x7fff);
  });

  it('chunks long text at 300 bytes without splitting characters', () => {
    const text = '₹'.repeat(250); // 3 bytes each = 750 bytes
    const chunks = scrcpyInjectText(text);
    expect(chunks.length).toBe(3);
    const decoded = chunks
      .map((c) => {
        const len = new DataView(c.buffer).getUint32(1);
        expect(len).toBeLessThanOrEqual(300);
        expect(len % 3).toBe(0);
        return new TextDecoder().decode(c.subarray(5));
      })
      .join('');
    expect(decoded).toBe(text);
    expect(scrcpyInjectText('')).toEqual([]);
  });

  it('encodes set-clipboard', () => {
    const b = scrcpySetClipboard('hi', true, 7n);
    expect([...b]).toEqual([9, 0, 0, 0, 0, 0, 0, 0, 7, 1, 0, 0, 0, 2, 0x68, 0x69]);
  });

  it('parses video packet headers', () => {
    const h = new Uint8Array(12);
    const v = new DataView(h.buffer);
    v.setBigUint64(0, (1n << 62n) | 33_333n);
    v.setUint32(8, 4096);
    expect(parseScrcpyPacketHeader(h)).toEqual({
      config: false,
      keyframe: true,
      pts: 33_333n,
      size: 4096,
    });
    v.setBigUint64(0, 1n << 63n);
    expect(parseScrcpyPacketHeader(h).config).toBe(true);
  });

  it('builds server args and validates scid', () => {
    const args = scrcpyServerArgs({ scid: '0a1b2c3d', maxSize: 1280, bitRate: 4e6, maxFps: 30 });
    expect(args).toContain('com.genymobile.scrcpy.Server 3.3.1');
    expect(args).toContain('scid=0a1b2c3d');
    expect(args).toContain('max_size=1280');
    expect(() =>
      scrcpyServerArgs({ scid: 'x; rm -rf', maxSize: 0, bitRate: 1, maxFps: 1 }),
    ).toThrow();
  });
});

describe('H.264 helpers', () => {
  // SPS NALs produced by x264 for real frame sizes.
  const spsHigh720 = hex('6764001facd940b40a1b011000000300100000030320f1831960');
  const spsBase2340 = hex('6742c032d900440127e59f011000000300100000030320f1832480');

  it('parses SPS dimensions (high profile)', () => {
    expect(parseSps(spsHigh720)).toMatchObject({
      profileIdc: 100,
      levelIdc: 31,
      width: 720,
      height: 1280,
    });
  });

  it('parses SPS dimensions with cropping (baseline, 2340 not a multiple of 16)', () => {
    expect(parseSps(spsBase2340)).toMatchObject({ profileIdc: 66, width: 1080, height: 2340 });
  });

  it('builds a WebCodecs codec string', () => {
    expect(avcCodecString(parseSps(spsHigh720))).toBe('avc1.64001f');
  });

  it('splits Annex-B streams with 3- and 4-byte start codes', () => {
    const stream = Uint8Array.from([
      0,
      0,
      0,
      1,
      ...spsHigh720,
      0,
      0,
      1,
      0x68,
      0xee,
      0,
      0,
      0,
      1,
      0x65,
      0x88,
      0x84,
    ]);
    const units = splitNalUnits(stream);
    expect(units.map((u) => u.type)).toEqual([NalType.SPS, NalType.PPS, NalType.IDR]);
    expect(units[0]!.data).toEqual(spsHigh720);
    expect(findSps(stream)?.width).toBe(720);
  });
});
