/**
 * scrcpy-server wire format (pinned to SCRCPY_SERVER_VERSION).
 * Reference: scrcpy app/src/control_msg.c and server/.../ControlMessageReader.java.
 */
import { DeviceKey, KeyAction, KeyMeta, TouchAction } from './frames';

export const SCRCPY_SERVER_VERSION = '3.3.4';

export const ScrcpyControlType = {
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATION_PANEL: 5,
  EXPAND_SETTINGS_PANEL: 6,
  COLLAPSE_PANELS: 7,
  GET_CLIPBOARD: 8,
  SET_CLIPBOARD: 9,
  SET_DISPLAY_POWER: 10,
  ROTATE_DEVICE: 11,
  RESET_VIDEO: 17,
} as const;

/** scrcpy limits a single INJECT_TEXT message to 300 bytes. */
export const SCRCPY_INJECT_TEXT_MAX = 300;
export const SCRCPY_CLIPBOARD_TEXT_MAX = (1 << 18) - 14;

/** Pointer ids understood by scrcpy-server. */
export const SCRCPY_POINTER_ID_MOUSE = -1n;
export const SCRCPY_POINTER_ID_GENERIC_FINGER = -2n;
export const SCRCPY_POINTER_ID_VIRTUAL_FINGER = -3n;

export const SCRCPY_PACKET_FLAG_CONFIG = 1n << 63n;
export const SCRCPY_PACKET_FLAG_KEY_FRAME = 1n << 62n;
export const SCRCPY_PACKET_PTS_MASK = SCRCPY_PACKET_FLAG_KEY_FRAME - 1n;
export const SCRCPY_PACKET_HEADER_SIZE = 12;
export const SCRCPY_DEVICE_NAME_FIELD_LENGTH = 64;
export const SCRCPY_CODEC_META_SIZE = 12;
/** "h264" as a big-endian u32. */
export const SCRCPY_CODEC_ID_H264 = 0x68323634;

/** Android KeyEvent keycodes for DeviceLab's platform-neutral keys. */
export const ANDROID_KEYCODES: Readonly<Record<DeviceKey, number>> = {
  [DeviceKey.HOME]: 3,
  [DeviceKey.BACK]: 4,
  [DeviceKey.RECENTS]: 187,
  [DeviceKey.POWER]: 26,
  [DeviceKey.VOLUME_UP]: 24,
  [DeviceKey.VOLUME_DOWN]: 25,
  [DeviceKey.ENTER]: 66,
  [DeviceKey.DEL]: 67,
  [DeviceKey.FORWARD_DEL]: 112,
  [DeviceKey.TAB]: 61,
  [DeviceKey.ESCAPE]: 111,
  [DeviceKey.DPAD_UP]: 19,
  [DeviceKey.DPAD_DOWN]: 20,
  [DeviceKey.DPAD_LEFT]: 21,
  [DeviceKey.DPAD_RIGHT]: 22,
  [DeviceKey.MOVE_HOME]: 122,
  [DeviceKey.MOVE_END]: 123,
  [DeviceKey.PAGE_UP]: 92,
  [DeviceKey.PAGE_DOWN]: 93,
  [DeviceKey.MENU]: 82,
  [DeviceKey.A]: 29,
  [DeviceKey.C]: 31,
  [DeviceKey.V]: 50,
  [DeviceKey.X]: 52,
  [DeviceKey.Z]: 54,
};

/** Translate KeyMeta bits into an Android KeyEvent meta state. */
export function androidMetaState(meta: number): number {
  let state = 0;
  if (meta & KeyMeta.SHIFT) state |= 0x1 | 0x40; // META_SHIFT_ON | META_SHIFT_LEFT_ON
  if (meta & KeyMeta.ALT) state |= 0x2 | 0x10; // META_ALT_ON | META_ALT_LEFT_ON
  if (meta & KeyMeta.CTRL) state |= 0x1000 | 0x2000; // META_CTRL_ON | META_CTRL_LEFT_ON
  if (meta & KeyMeta.META) state |= 0x10000 | 0x20000; // META_META_ON | META_META_LEFT_ON
  return state;
}

const enc = new TextEncoder();

function msg(size: number): { buf: Uint8Array; view: DataView } {
  const buf = new Uint8Array(size);
  return { buf, view: new DataView(buf.buffer) };
}

export function scrcpyInjectKeycode(
  action: KeyAction,
  keycode: number,
  repeat = 0,
  metaState = 0,
): Uint8Array {
  const { buf, view } = msg(14);
  view.setUint8(0, ScrcpyControlType.INJECT_KEYCODE);
  view.setUint8(1, action === KeyAction.DOWN ? 0 : 1); // AKEY_EVENT_ACTION_DOWN / UP
  view.setInt32(2, keycode);
  view.setInt32(6, repeat);
  view.setInt32(10, metaState);
  return buf;
}

/** Split text into ≤300-byte UTF-8 chunks without cutting a code point. */
export function scrcpyInjectText(text: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  let chunk = '';
  let chunkBytes = 0;
  const flush = (): void => {
    if (!chunk) return;
    const bytes = enc.encode(chunk);
    const { buf, view } = msg(5 + bytes.byteLength);
    view.setUint8(0, ScrcpyControlType.INJECT_TEXT);
    view.setUint32(1, bytes.byteLength);
    buf.set(bytes, 5);
    out.push(buf);
    chunk = '';
    chunkBytes = 0;
  };
  for (const ch of text) {
    const n = enc.encode(ch).byteLength;
    if (chunkBytes + n > SCRCPY_INJECT_TEXT_MAX) flush();
    chunk += ch;
    chunkBytes += n;
  }
  flush();
  return out;
}

const ANDROID_MOTION_ACTION: Record<TouchAction, number> = {
  [TouchAction.DOWN]: 0, // AMOTION_EVENT_ACTION_DOWN
  [TouchAction.UP]: 1, // AMOTION_EVENT_ACTION_UP
  [TouchAction.MOVE]: 2, // AMOTION_EVENT_ACTION_MOVE
  [TouchAction.CANCEL]: 3, // AMOTION_EVENT_ACTION_CANCEL
};

export function scrcpyInjectTouch(opts: {
  action: TouchAction;
  pointerId: bigint;
  x: number;
  y: number;
  screenW: number;
  screenH: number;
}): Uint8Array {
  const { buf, view } = msg(32);
  view.setUint8(0, ScrcpyControlType.INJECT_TOUCH_EVENT);
  view.setUint8(1, ANDROID_MOTION_ACTION[opts.action]);
  view.setBigInt64(2, opts.pointerId);
  view.setInt32(10, opts.x);
  view.setInt32(14, opts.y);
  view.setUint16(18, opts.screenW);
  view.setUint16(20, opts.screenH);
  view.setUint16(22, opts.action === TouchAction.UP ? 0 : 0xffff); // pressure (u16 fixed point)
  view.setInt32(24, 0); // action button
  view.setInt32(28, 0); // buttons
  return buf;
}

function floatToI16fp(f: number): number {
  const clamped = Math.max(-1, Math.min(1, f));
  return Math.max(-0x8000, Math.min(0x7fff, Math.round(clamped * 0x8000)));
}

/** hscroll/vscroll are in notches, accepted range [-16, 16]. */
export function scrcpyInjectScroll(opts: {
  x: number;
  y: number;
  screenW: number;
  screenH: number;
  hscroll: number;
  vscroll: number;
}): Uint8Array {
  const { buf, view } = msg(21);
  view.setUint8(0, ScrcpyControlType.INJECT_SCROLL_EVENT);
  view.setInt32(1, opts.x);
  view.setInt32(5, opts.y);
  view.setUint16(9, opts.screenW);
  view.setUint16(11, opts.screenH);
  view.setInt16(13, floatToI16fp(opts.hscroll / 16));
  view.setInt16(15, floatToI16fp(opts.vscroll / 16));
  view.setInt32(17, 0);
  return buf;
}

export function scrcpySetClipboard(text: string, paste: boolean, sequence = 0n): Uint8Array {
  let bytes = enc.encode(text);
  if (bytes.byteLength > SCRCPY_CLIPBOARD_TEXT_MAX)
    bytes = bytes.subarray(0, SCRCPY_CLIPBOARD_TEXT_MAX);
  const { buf, view } = msg(14 + bytes.byteLength);
  view.setUint8(0, ScrcpyControlType.SET_CLIPBOARD);
  view.setBigUint64(1, sequence);
  view.setUint8(9, paste ? 1 : 0);
  view.setUint32(10, bytes.byteLength);
  buf.set(bytes, 14);
  return buf;
}

export function scrcpySimple(
  type:
    | typeof ScrcpyControlType.ROTATE_DEVICE
    | typeof ScrcpyControlType.RESET_VIDEO
    | typeof ScrcpyControlType.EXPAND_NOTIFICATION_PANEL
    | typeof ScrcpyControlType.COLLAPSE_PANELS,
): Uint8Array {
  return Uint8Array.of(type);
}

export function scrcpySetDisplayPower(on: boolean): Uint8Array {
  return Uint8Array.of(ScrcpyControlType.SET_DISPLAY_POWER, on ? 1 : 0);
}

export interface ScrcpyPacketHeader {
  config: boolean;
  keyframe: boolean;
  /** Microseconds. */
  pts: bigint;
  size: number;
}

export function parseScrcpyPacketHeader(header: Uint8Array): ScrcpyPacketHeader {
  if (header.byteLength < SCRCPY_PACKET_HEADER_SIZE) throw new Error('short scrcpy packet header');
  const view = new DataView(header.buffer, header.byteOffset, SCRCPY_PACKET_HEADER_SIZE);
  const ptsFlags = view.getBigUint64(0);
  return {
    config: (ptsFlags & SCRCPY_PACKET_FLAG_CONFIG) !== 0n,
    keyframe: (ptsFlags & SCRCPY_PACKET_FLAG_KEY_FRAME) !== 0n,
    pts: ptsFlags & SCRCPY_PACKET_PTS_MASK,
    size: view.getUint32(8),
  };
}

/** Build the app_process argument list for scrcpy-server. */
export function scrcpyServerArgs(opts: {
  scid: string;
  maxSize: number;
  bitRate: number;
  maxFps: number;
  jarPath?: string;
  codecOptions?: string;
}): string {
  const jar = opts.jarPath ?? '/data/local/tmp/scrcpy-server.jar';
  if (!/^[0-9a-f]{8}$/.test(opts.scid)) throw new Error('scid must be 8 hex chars');
  const params = [
    `scid=${opts.scid}`,
    'log_level=info',
    'tunnel_forward=true',
    'audio=false',
    'control=true',
    'cleanup=true',
    'video_codec=h264',
    `max_size=${Math.floor(opts.maxSize)}`,
    `video_bit_rate=${Math.floor(opts.bitRate)}`,
    `max_fps=${Math.floor(opts.maxFps)}`,
    'send_device_meta=true',
    'send_frame_meta=true',
    'send_dummy_byte=true',
    'send_codec_meta=true',
    'stay_awake=true',
    'power_off_on_close=false',
  ];
  // Optional MediaCodec hints, e.g. "latency:int=0". Off by default: some vendor encoders reject unknown keys.
  if (opts.codecOptions) params.push(`video_codec_options=${opts.codecOptions}`);
  return `CLASSPATH=${jar} app_process / com.genymobile.scrcpy.Server ${SCRCPY_SERVER_VERSION} ${params.join(' ')}`;
}
