/**
 * DeviceLab binary stream protocol, v1.
 *
 * Every WebSocket binary message is exactly one frame:
 *
 *   byte 0  version (PROTOCOL_VERSION)
 *   byte 1  type    (FrameType)
 *   byte 2  flags   (type-specific bit field)
 *   byte 3  reserved (0)
 *   4..     body    (type-specific, big-endian)
 *
 * Browser-safe: only Uint8Array/DataView, no Node Buffer.
 */

export const PROTOCOL_VERSION = 1;
export const HEADER_SIZE = 4;

export const FrameType = {
  VIDEO_CONFIG: 0x01,
  VIDEO_FRAME: 0x02,
  MJPEG_FRAME: 0x03,
  PING: 0x0e,
  PONG: 0x0f,
  TOUCH: 0x20,
  KEY: 0x21,
  TEXT: 0x22,
  SCROLL: 0x23,
  CLIPBOARD: 0x24,
  ROTATE: 0x25,
  REQUEST_KEYFRAME: 0x26,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

/** Frames the server forwards from a controller to the agent. Anything else from a viewer is dropped. */
export const INPUT_FRAME_TYPES: ReadonlySet<number> = new Set([
  FrameType.TOUCH,
  FrameType.KEY,
  FrameType.TEXT,
  FrameType.SCROLL,
  FrameType.CLIPBOARD,
  FrameType.ROTATE,
]);

export const VideoCodec = { H264: 1 } as const;
export type VideoCodec = (typeof VideoCodec)[keyof typeof VideoCodec];

export const TouchAction = { DOWN: 0, UP: 1, MOVE: 2, CANCEL: 3 } as const;
export type TouchAction = (typeof TouchAction)[keyof typeof TouchAction];

export const KeyAction = { DOWN: 0, UP: 1 } as const;
export type KeyAction = (typeof KeyAction)[keyof typeof KeyAction];

/** Platform-neutral key identifiers. Drivers map these to Android keycodes / WDA buttons. */
export const DeviceKey = {
  HOME: 1,
  BACK: 2,
  RECENTS: 3,
  POWER: 4,
  VOLUME_UP: 5,
  VOLUME_DOWN: 6,
  ENTER: 7,
  DEL: 8,
  FORWARD_DEL: 9,
  TAB: 10,
  ESCAPE: 11,
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
  MOVE_HOME: 16,
  MOVE_END: 17,
  PAGE_UP: 18,
  PAGE_DOWN: 19,
  MENU: 20,
  A: 21,
  C: 22,
  V: 23,
  X: 24,
  Z: 25,
} as const;
export type DeviceKey = (typeof DeviceKey)[keyof typeof DeviceKey];

/** Modifier bits carried in KeyFrame.meta. */
export const KeyMeta = { SHIFT: 1, CTRL: 2, ALT: 4, META: 8 } as const;

/** Coordinates are normalised to 0..NORM_MAX across the visible frame. */
export const NORM_MAX = 0xffff;

export const VIDEO_FLAG_KEYFRAME = 0x01;

export interface VideoConfigFrame {
  type: typeof FrameType.VIDEO_CONFIG;
  codec: VideoCodec;
  width: number;
  height: number;
  /** Annex-B SPS + PPS NAL units. */
  data: Uint8Array;
}
export interface VideoFrame {
  type: typeof FrameType.VIDEO_FRAME;
  keyframe: boolean;
  /** Presentation timestamp in microseconds. */
  pts: bigint;
  /** Annex-B access unit. */
  data: Uint8Array;
}
export interface MjpegFrame {
  type: typeof FrameType.MJPEG_FRAME;
  width: number;
  height: number;
  data: Uint8Array;
}
export interface PingFrame {
  type: typeof FrameType.PING | typeof FrameType.PONG;
  seq: number;
  /** Sender's clock, epoch ms. */
  t: number;
}
export interface TouchFrame {
  type: typeof FrameType.TOUCH;
  action: TouchAction;
  pointerId: number;
  x: number;
  y: number;
}
export interface KeyFrame {
  type: typeof FrameType.KEY;
  action: KeyAction;
  key: DeviceKey;
  meta: number;
}
export interface TextFrame {
  type: typeof FrameType.TEXT;
  text: string;
}
export interface ScrollFrame {
  type: typeof FrameType.SCROLL;
  x: number;
  y: number;
  /** Scroll amount, in notches (-16..16). Positive dy scrolls content up (wheel up). */
  dx: number;
  dy: number;
}
export interface ClipboardFrame {
  type: typeof FrameType.CLIPBOARD;
  /** Also paste into the focused field after setting the clipboard. */
  paste: boolean;
  text: string;
}
export interface BareFrame {
  type: typeof FrameType.ROTATE | typeof FrameType.REQUEST_KEYFRAME;
}

export type Frame =
  | VideoConfigFrame
  | VideoFrame
  | MjpegFrame
  | PingFrame
  | TouchFrame
  | KeyFrame
  | TextFrame
  | ScrollFrame
  | ClipboardFrame
  | BareFrame;

export class ProtocolError extends Error {}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Max UTF-8 bytes accepted in a TEXT / CLIPBOARD frame. */
export const MAX_TEXT_BYTES = 64 * 1024;

function alloc(type: FrameType, bodySize: number, flags = 0): { buf: Uint8Array; view: DataView } {
  const buf = new Uint8Array(HEADER_SIZE + bodySize);
  buf[0] = PROTOCOL_VERSION;
  buf[1] = type;
  buf[2] = flags;
  buf[3] = 0;
  return { buf, view: new DataView(buf.buffer, buf.byteOffset, buf.byteLength) };
}

function clampU16(v: number): number {
  return Math.max(0, Math.min(0xffff, Math.round(v)));
}

function clampI16(v: number): number {
  return Math.max(-0x8000, Math.min(0x7fff, Math.round(v)));
}

export function encodeFrame(frame: Frame): Uint8Array {
  switch (frame.type) {
    case FrameType.VIDEO_CONFIG: {
      const { buf, view } = alloc(frame.type, 5 + frame.data.byteLength);
      view.setUint8(4, frame.codec);
      view.setUint16(5, frame.width);
      view.setUint16(7, frame.height);
      buf.set(frame.data, 9);
      return buf;
    }
    case FrameType.VIDEO_FRAME: {
      const { buf, view } = alloc(
        frame.type,
        8 + frame.data.byteLength,
        frame.keyframe ? VIDEO_FLAG_KEYFRAME : 0,
      );
      view.setBigUint64(4, frame.pts);
      buf.set(frame.data, 12);
      return buf;
    }
    case FrameType.MJPEG_FRAME: {
      const { buf, view } = alloc(frame.type, 4 + frame.data.byteLength);
      view.setUint16(4, frame.width);
      view.setUint16(6, frame.height);
      buf.set(frame.data, 8);
      return buf;
    }
    case FrameType.PING:
    case FrameType.PONG: {
      const { buf, view } = alloc(frame.type, 12);
      view.setUint32(4, frame.seq >>> 0);
      view.setBigUint64(8, BigInt(Math.max(0, Math.floor(frame.t))));
      return buf;
    }
    case FrameType.TOUCH: {
      const { buf, view } = alloc(frame.type, 6);
      view.setUint8(4, frame.action);
      view.setUint8(5, frame.pointerId & 0xff);
      view.setUint16(6, clampU16(frame.x));
      view.setUint16(8, clampU16(frame.y));
      return buf;
    }
    case FrameType.KEY: {
      const { buf, view } = alloc(frame.type, 7);
      view.setUint8(4, frame.action);
      view.setUint16(5, frame.key);
      view.setUint32(7, frame.meta >>> 0);
      return buf;
    }
    case FrameType.TEXT: {
      const bytes = textEncoder.encode(frame.text);
      if (bytes.byteLength > MAX_TEXT_BYTES) throw new ProtocolError('text too long');
      const { buf } = alloc(frame.type, bytes.byteLength);
      buf.set(bytes, 4);
      return buf;
    }
    case FrameType.SCROLL: {
      const { buf, view } = alloc(frame.type, 8);
      view.setUint16(4, clampU16(frame.x));
      view.setUint16(6, clampU16(frame.y));
      view.setInt16(8, clampI16(frame.dx * 256));
      view.setInt16(10, clampI16(frame.dy * 256));
      return buf;
    }
    case FrameType.CLIPBOARD: {
      const bytes = textEncoder.encode(frame.text);
      if (bytes.byteLength > MAX_TEXT_BYTES) throw new ProtocolError('clipboard too long');
      const { buf, view } = alloc(frame.type, 1 + bytes.byteLength);
      view.setUint8(4, frame.paste ? 1 : 0);
      buf.set(bytes, 5);
      return buf;
    }
    case FrameType.ROTATE:
    case FrameType.REQUEST_KEYFRAME:
      return alloc(frame.type, 0).buf;
  }
}

function need(buf: Uint8Array, bytes: number, what: string): void {
  if (buf.byteLength < HEADER_SIZE + bytes) throw new ProtocolError(`${what}: truncated frame`);
}

/** Cheap header peek, used by the relay to route without decoding the body. */
export function peekFrameType(buf: Uint8Array): number | null {
  if (buf.byteLength < HEADER_SIZE || buf[0] !== PROTOCOL_VERSION) return null;
  return buf[1] ?? null;
}

export function decodeFrame(input: Uint8Array | ArrayBuffer): Frame {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (buf.byteLength < HEADER_SIZE) throw new ProtocolError('frame shorter than header');
  if (buf[0] !== PROTOCOL_VERSION)
    throw new ProtocolError(`unsupported protocol version ${buf[0]}`);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const type = buf[1];
  const flags = buf[2] ?? 0;
  switch (type) {
    case FrameType.VIDEO_CONFIG: {
      need(buf, 5, 'VIDEO_CONFIG');
      const codec = view.getUint8(4);
      if (codec !== VideoCodec.H264) throw new ProtocolError(`unknown codec ${codec}`);
      return {
        type,
        codec,
        width: view.getUint16(5),
        height: view.getUint16(7),
        data: buf.subarray(9),
      };
    }
    case FrameType.VIDEO_FRAME:
      need(buf, 8, 'VIDEO_FRAME');
      return {
        type,
        keyframe: (flags & VIDEO_FLAG_KEYFRAME) !== 0,
        pts: view.getBigUint64(4),
        data: buf.subarray(12),
      };
    case FrameType.MJPEG_FRAME:
      need(buf, 4, 'MJPEG_FRAME');
      return { type, width: view.getUint16(4), height: view.getUint16(6), data: buf.subarray(8) };
    case FrameType.PING:
    case FrameType.PONG:
      need(buf, 12, 'PING');
      return { type, seq: view.getUint32(4), t: Number(view.getBigUint64(8)) };
    case FrameType.TOUCH: {
      need(buf, 6, 'TOUCH');
      const action = view.getUint8(4);
      if (action > TouchAction.CANCEL) throw new ProtocolError(`bad touch action ${action}`);
      return {
        type,
        action: action as TouchAction,
        pointerId: view.getUint8(5),
        x: view.getUint16(6),
        y: view.getUint16(8),
      };
    }
    case FrameType.KEY: {
      need(buf, 7, 'KEY');
      const action = view.getUint8(4);
      if (action > KeyAction.UP) throw new ProtocolError(`bad key action ${action}`);
      return {
        type,
        action: action as KeyAction,
        key: view.getUint16(5) as DeviceKey,
        meta: view.getUint32(7),
      };
    }
    case FrameType.TEXT:
      if (buf.byteLength - HEADER_SIZE > MAX_TEXT_BYTES) throw new ProtocolError('text too long');
      return { type, text: textDecoder.decode(buf.subarray(4)) };
    case FrameType.SCROLL:
      need(buf, 8, 'SCROLL');
      return {
        type,
        x: view.getUint16(4),
        y: view.getUint16(6),
        dx: view.getInt16(8) / 256,
        dy: view.getInt16(10) / 256,
      };
    case FrameType.CLIPBOARD:
      need(buf, 1, 'CLIPBOARD');
      if (buf.byteLength - HEADER_SIZE - 1 > MAX_TEXT_BYTES)
        throw new ProtocolError('clipboard too long');
      return { type, paste: view.getUint8(4) === 1, text: textDecoder.decode(buf.subarray(5)) };
    case FrameType.ROTATE:
    case FrameType.REQUEST_KEYFRAME:
      return { type };
    default:
      throw new ProtocolError(`unknown frame type 0x${(type ?? 0).toString(16)}`);
  }
}

/** Map a normalised coordinate (0..NORM_MAX) onto a pixel range [0, size). */
export function denormalize(v: number, size: number): number {
  if (size <= 0) return 0;
  return Math.min(size - 1, Math.max(0, Math.round((v / NORM_MAX) * (size - 1))));
}

export function normalize(px: number, size: number): number {
  if (size <= 1) return 0;
  return clampU16((px / (size - 1)) * NORM_MAX);
}
