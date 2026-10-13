import { Box } from '@mui/material';
import {
  DeviceKey,
  FrameType,
  KeyAction,
  KeyMeta,
  NORM_MAX,
  TouchAction,
  decodeFrame,
  encodeFrame,
} from '@devicelab/protocol';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { type RendererStats, ScreenRenderer } from './renderer';
import { type StreamTransport } from './transport';

export interface ViewerStats extends RendererStats {
  /** Round trip portal → server → agent → portal, ms. */
  rttMs: number | null;
}

export interface ScreenViewerHandle {
  key(key: DeviceKey, meta?: number): void;
  text(text: string): void;
  paste(text: string): void;
  rotate(): void;
  focus(): void;
  snapshot(): string | null;
}

export interface ScreenViewerProps {
  transport: StreamTransport | null;
  /** Observers render the stream but never send input. */
  interactive: boolean;
  zoom?: 'fit' | 'actual';
  deviceFrame?: boolean;
  overlay?: ReactNode;
  onStats?: (stats: ViewerStats) => void;
  /** Return true to consume a key combination (session shortcuts like Ctrl+H). */
  onShortcut?: (e: ReactKeyboardEvent) => boolean;
}

const KEY_MAP: Record<string, DeviceKey> = {
  Enter: DeviceKey.ENTER,
  Backspace: DeviceKey.DEL,
  Delete: DeviceKey.FORWARD_DEL,
  Tab: DeviceKey.TAB,
  Escape: DeviceKey.BACK,
  ArrowUp: DeviceKey.DPAD_UP,
  ArrowDown: DeviceKey.DPAD_DOWN,
  ArrowLeft: DeviceKey.DPAD_LEFT,
  ArrowRight: DeviceKey.DPAD_RIGHT,
  Home: DeviceKey.MOVE_HOME,
  End: DeviceKey.MOVE_END,
  PageUp: DeviceKey.PAGE_UP,
  PageDown: DeviceKey.PAGE_DOWN,
};

const CTRL_KEYS: Record<string, DeviceKey> = {
  a: DeviceKey.A,
  c: DeviceKey.C,
  x: DeviceKey.X,
  z: DeviceKey.Z,
};

function metaOf(e: {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): number {
  return (
    (e.shiftKey ? KeyMeta.SHIFT : 0) |
    (e.ctrlKey ? KeyMeta.CTRL : 0) |
    (e.altKey ? KeyMeta.ALT : 0) |
    (e.metaKey ? KeyMeta.META : 0)
  );
}

/**
 * Live device screen: decodes the stream and maps mouse/keyboard to device
 * input. Click → tap, drag → swipe, wheel → scroll, Alt+drag → pinch,
 * typing → text, Ctrl/⌘+V → paste.
 */
export const ScreenViewer = forwardRef<ScreenViewerHandle, ScreenViewerProps>(function ScreenViewer(
  { transport, interactive, zoom = 'fit', deviceFrame = true, overlay, onStats, onShortcut },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const rendererRef = useRef<ScreenRenderer | null>(null);
  const pinchRef = useRef<{ cx: number; cy: number } | null>(null);
  const pressedRef = useRef(false);
  const rttRef = useRef<number | null>(null);
  const [frameSize, setFrameSize] = useState({ w: 0, h: 0 });
  const [box, setBox] = useState({ w: 0, h: 0 });
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;

  const send = useCallback(
    (frame: Parameters<typeof encodeFrame>[0]) => {
      if (interactive || frame.type === FrameType.PING) transport?.send(encodeFrame(frame));
    },
    [interactive, transport],
  );

  // Decoder lifecycle + incoming frames.
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || !transport) return;
    const renderer = new ScreenRenderer(canvas, video, (s) => {
      setFrameSize((prev) =>
        prev.w === s.width && prev.h === s.height ? prev : { w: s.width, h: s.height },
      );
      onStatsRef.current?.({ ...s, rttMs: rttRef.current });
    });
    rendererRef.current = renderer;
    transport.onFrame((bytes) => {
      let frame;
      try {
        frame = decodeFrame(bytes);
      } catch {
        return;
      }
      if (frame.type === FrameType.PONG) {
        rttRef.current = Math.max(0, Date.now() - frame.t);
        return;
      }
      renderer.handle(frame);
    });
    let seq = 0;
    const ping = setInterval(() => {
      if (transport.isOpen)
        transport.send(encodeFrame({ type: FrameType.PING, seq: seq++, t: Date.now() }));
    }, 2000);
    return () => {
      clearInterval(ping);
      renderer.destroy();
      rendererRef.current = null;
    };
  }, [transport]);

  // Fit the screen into the available space, keeping the aspect ratio.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const pad = deviceFrame ? 28 : 0;
      const cw = el.clientWidth - pad;
      const ch = el.clientHeight - pad;
      const fw = frameSize.w || 9;
      const fh = frameSize.h || 19.5;
      if (zoom === 'actual' && frameSize.w) {
        setBox({ w: frameSize.w, h: frameSize.h });
        return;
      }
      const a = fw / fh;
      const w = Math.max(0, Math.min(cw, ch * a));
      setBox({ w: Math.floor(w), h: Math.floor(w / a) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [frameSize, zoom, deviceFrame]);

  const norm = useCallback((clientX: number, clientY: number) => {
    const r = screenRef.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return { x: 0, y: 0 };
    const x = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    return { x: x * NORM_MAX, y: y * NORM_MAX };
  }, []);

  const touch = useCallback(
    (action: TouchAction, clientX: number, clientY: number) => {
      const p = norm(clientX, clientY);
      send({ type: FrameType.TOUCH, action, pointerId: 0, x: p.x, y: p.y });
      const pinch = pinchRef.current;
      if (pinch) {
        // Second finger mirrored around the pinch centre.
        send({
          type: FrameType.TOUCH,
          action,
          pointerId: 1,
          x: 2 * pinch.cx - p.x,
          y: 2 * pinch.cy - p.y,
        });
      }
    },
    [norm, send],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive || e.button !== 0) return;
    screenRef.current?.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    pressedRef.current = true;
    if (e.altKey) {
      const r = screenRef.current!.getBoundingClientRect();
      const c = norm(r.left + r.width / 2, r.top + r.height / 2);
      pinchRef.current = { cx: c.x, cy: c.y };
    }
    touch(TouchAction.DOWN, e.clientX, e.clientY);
  };

  const lastMove = useRef(0);
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive || !pressedRef.current) return;
    const now = performance.now();
    if (now - lastMove.current < 8) return; // ~120 Hz cap
    lastMove.current = now;
    touch(TouchAction.MOVE, e.clientX, e.clientY);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive || !pressedRef.current) return;
    pressedRef.current = false;
    touch(TouchAction.UP, e.clientX, e.clientY);
    pinchRef.current = null;
  };

  // Native (non-passive) wheel listener so we can preventDefault page scroll.
  useEffect(() => {
    const el = screenRef.current;
    if (!el) return;
    let last = 0;
    const onWheel = (e: WheelEvent) => {
      if (!interactive) return;
      e.preventDefault();
      const now = performance.now();
      if (now - last < 16) return;
      last = now;
      const p = norm(e.clientX, e.clientY);
      const scale = e.deltaMode === 1 ? 1 : 1 / 100;
      const dy = Math.max(-4, Math.min(4, -e.deltaY * scale));
      const dx = Math.max(-4, Math.min(4, -e.deltaX * scale));
      send({ type: FrameType.SCROLL, x: p.x, y: p.y, dx, dy });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [interactive, norm, send]);

  const pressKey = useCallback(
    (key: DeviceKey, meta = 0) => {
      send({ type: FrameType.KEY, action: KeyAction.DOWN, key, meta });
      send({ type: FrameType.KEY, action: KeyAction.UP, key, meta });
    },
    [send],
  );

  const paste = useCallback(
    (text: string) => send({ type: FrameType.CLIPBOARD, paste: true, text }),
    [send],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (onShortcut?.(e)) {
      e.preventDefault();
      return;
    }
    if (!interactive) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      navigator.clipboard
        ?.readText()
        .then((t) => t && paste(t))
        .catch(() => undefined);
      return;
    }
    if (mod && CTRL_KEYS[e.key.toLowerCase()] !== undefined) {
      e.preventDefault();
      pressKey(CTRL_KEYS[e.key.toLowerCase()]!, KeyMeta.CTRL);
      return;
    }
    const mapped = KEY_MAP[e.key];
    if (mapped !== undefined) {
      e.preventDefault();
      pressKey(mapped, metaOf(e));
      return;
    }
    if (e.key.length === 1 && !mod && !e.altKey) {
      e.preventDefault();
      send({ type: FrameType.TEXT, text: e.key });
    }
  };

  useImperativeHandle(
    ref,
    () => ({
      key: pressKey,
      text: (t) => send({ type: FrameType.TEXT, text: t }),
      paste,
      rotate: () => send({ type: FrameType.ROTATE }),
      focus: () => screenRef.current?.focus(),
      snapshot: () => rendererRef.current?.snapshot() ?? null,
    }),
    [pressKey, paste, send],
  );

  return (
    <Box
      ref={containerRef}
      sx={{
        position: 'relative',
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: 'grid',
        placeItems: 'center',
        overflow: zoom === 'actual' ? 'auto' : 'hidden',
      }}
    >
      <Box
        sx={
          deviceFrame
            ? {
                p: '12px',
                borderRadius: '34px',
                bgcolor: '#0b0f17',
                boxShadow: (t) => `0 0 0 1px ${t.palette.divider}, 0 18px 50px rgba(2,6,23,0.35)`,
              }
            : undefined
        }
      >
        <Box
          ref={screenRef}
          tabIndex={0}
          data-testid="screen"
          aria-label={
            interactive
              ? 'Device screen — click to interact, type to send keys'
              : 'Device screen (view only)'
          }
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (!interactive) return;
            const t = e.clipboardData.getData('text');
            if (t) paste(t);
            e.preventDefault();
          }}
          onContextMenu={(e) => e.preventDefault()}
          sx={{
            position: 'relative',
            width: box.w || 280,
            height: box.h || 600,
            borderRadius: deviceFrame ? '22px' : 1,
            overflow: 'hidden',
            bgcolor: '#000',
            outline: 'none',
            cursor: interactive ? 'pointer' : 'default',
            touchAction: 'none',
            userSelect: 'none',
            '&:focus-visible': { boxShadow: (t) => `0 0 0 3px ${t.palette.primary.main}` },
          }}
        >
          <canvas
            ref={canvasRef}
            data-testid="screen-canvas"
            style={{ width: '100%', height: '100%', display: 'block' }}
          />
          <video
            ref={videoRef}
            muted
            autoPlay
            playsInline
            style={{ width: '100%', height: '100%', display: 'none', objectFit: 'fill' }}
          />
          {overlay && (
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                display: 'grid',
                placeItems: 'center',
                pointerEvents: 'none',
              }}
            >
              {overlay}
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
});
