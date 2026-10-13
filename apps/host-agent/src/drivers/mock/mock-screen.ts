import { DeviceKey, NORM_MAX, TouchAction } from '@devicelab/protocol';
import { Canvas, type RGB } from './canvas';

export interface MockApp {
  packageId: string;
  label: string;
  color: RGB;
  system: boolean;
  /** Simulates FLAG_SECURE: the screen goes black while this app is in front. */
  secure?: boolean;
}

interface Touch {
  x: number;
  y: number;
  at: number;
}

const WHITE: RGB = [255, 255, 255];
const MUTED: RGB = [148, 163, 184];
const DARK: RGB = [15, 23, 42];

/**
 * A tiny simulated phone UI: home grid → app screen with a text field and a
 * scrollable list. Enough to demo and test touch, keys, text, scroll, rotate.
 */
export class MockScreen {
  private canvas: Canvas;
  private portrait = true;
  private screenOn = true;
  private foreground: MockApp | null = null;
  private typed = '';
  private scrollY = 0;
  private trail: Touch[] = [];
  private dragStart: { x: number; y: number; scrollY: number } | null = null;
  private volume = 7;
  private volumeShownUntil = 0;
  private frameNo = 0;
  dirty = true;

  constructor(
    private readonly baseW: number,
    private readonly baseH: number,
    readonly model: string,
    private readonly accent: RGB,
    readonly platform: 'ANDROID' | 'IOS',
    readonly apps: MockApp[],
    private batteryFn: () => number,
  ) {
    this.canvas = new Canvas(baseW, baseH);
  }

  get width(): number {
    return this.portrait ? this.baseW : this.baseH;
  }
  get height(): number {
    return this.portrait ? this.baseH : this.baseW;
  }
  get secureVisible(): boolean {
    return Boolean(this.foreground?.secure) && this.screenOn;
  }

  /** Lines describing UI events, consumed by the mock logcat. */
  readonly events: string[] = [];

  rotate(): void {
    this.portrait = !this.portrait;
    this.canvas = new Canvas(this.width, this.height);
    this.events.push(
      `WindowManager: rotation changed to ${this.portrait ? 'portrait' : 'landscape'}`,
    );
    this.dirty = true;
  }

  home(): void {
    if (this.foreground)
      this.events.push(`ActivityManager: ${this.foreground.packageId} moved to background`);
    this.foreground = null;
    this.scrollY = 0;
    this.dirty = true;
  }

  launch(packageId: string): boolean {
    const app = this.apps.find((a) => a.packageId === packageId);
    if (!app) return false;
    this.foreground = app;
    this.scrollY = 0;
    this.events.push(
      `ActivityManager: Start proc ${app.packageId} for activity ${app.packageId}/.MainActivity`,
    );
    this.dirty = true;
    return true;
  }

  reset(): void {
    this.home();
    this.typed = '';
    this.screenOn = true;
    if (!this.portrait) this.rotate();
  }

  // ------------------------------------------------------------------ input

  touch(action: number, nx: number, ny: number): void {
    const x = (nx / NORM_MAX) * (this.width - 1);
    const y = (ny / NORM_MAX) * (this.height - 1);
    const now = Date.now();
    this.trail.push({ x, y, at: now });
    if (this.trail.length > 40) this.trail.shift();
    this.dirty = true;
    if (!this.screenOn) {
      if (action === TouchAction.UP) this.screenOn = true; // tap to wake
      return;
    }
    if (action === TouchAction.DOWN) {
      this.dragStart = { x, y, scrollY: this.scrollY };
    } else if (action === TouchAction.MOVE && this.dragStart && this.foreground) {
      this.scrollY = Math.max(0, this.dragStart.scrollY - (y - this.dragStart.y));
    } else if (action === TouchAction.UP && this.dragStart) {
      const moved = Math.hypot(x - this.dragStart.x, y - this.dragStart.y);
      this.dragStart = null;
      if (moved < 12) this.tap(x, y);
      else this.events.push(`InputDispatcher: swipe ended at (${Math.round(x)},${Math.round(y)})`);
    }
  }

  private tap(x: number, y: number): void {
    this.events.push(`InputDispatcher: tap at (${Math.round(x)},${Math.round(y)})`);
    if (this.foreground) {
      if (y < 70 && x < 90) this.home(); // "‹ Back"
      return;
    }
    const hit = this.iconLayout().find(
      (ic) => x >= ic.x && x <= ic.x + ic.size && y >= ic.y && y <= ic.y + ic.size + 18,
    );
    if (hit) this.launch(hit.app.packageId);
  }

  scroll(dy: number): void {
    if (!this.foreground) return;
    this.scrollY = Math.max(0, this.scrollY - dy * 40);
    this.dirty = true;
  }

  key(key: number, down: boolean): void {
    if (!down) return;
    this.dirty = true;
    switch (key) {
      case DeviceKey.HOME:
        this.home();
        break;
      case DeviceKey.BACK:
      case DeviceKey.ESCAPE:
        this.home();
        break;
      case DeviceKey.POWER:
        this.screenOn = !this.screenOn;
        this.events.push(`PowerManager: screen ${this.screenOn ? 'on' : 'off'}`);
        break;
      case DeviceKey.VOLUME_UP:
      case DeviceKey.VOLUME_DOWN:
        this.volume = Math.max(
          0,
          Math.min(15, this.volume + (key === DeviceKey.VOLUME_UP ? 1 : -1)),
        );
        this.volumeShownUntil = Date.now() + 1500;
        break;
      case DeviceKey.DEL:
        this.typed = this.typed.slice(0, -1);
        break;
      case DeviceKey.ENTER:
        this.typed += '\n';
        break;
      case DeviceKey.RECENTS:
        this.events.push('RecentsActivity: shown');
        break;
      default:
        break;
    }
  }

  typeText(text: string): void {
    this.typed = (this.typed + text).slice(-400);
    this.events.push(`InputMethod: committed ${text.length} chars`);
    this.dirty = true;
  }

  // ------------------------------------------------------------------ render

  private iconLayout(): { app: MockApp; x: number; y: number; size: number }[] {
    const cols = this.portrait ? 4 : 6;
    const size = Math.floor(Math.min(this.width / (cols + 1.6), 72));
    const gap = (this.width - cols * size) / (cols + 1);
    return this.apps.map((app, i) => ({
      app,
      size,
      x: gap + (i % cols) * (size + gap),
      y: 110 + Math.floor(i / cols) * (size + 38),
    }));
  }

  /** Render the current frame. The canvas is reused; callers must copy if they keep it. */
  render(): Canvas {
    const c = this.canvas;
    const now = Date.now();
    this.frameNo++;
    if (!this.screenOn || this.secureVisible) {
      c.fill([0, 0, 0]);
      return c;
    }
    if (this.foreground) this.renderApp(c, this.foreground);
    else this.renderHome(c);

    // Status bar
    c.rect(0, 0, c.width, 28, [0, 0, 0], 0.35);
    const d = new Date();
    c.text(
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
      12,
      7,
      WHITE,
    );
    const batt = `${this.batteryFn()}%`;
    c.text(batt, c.width - batt.length * 8 - 12, 7, WHITE);

    // Liveness ticker so a frozen stream is obvious
    const tick = (this.frameNo * 3) % c.width;
    c.rect(tick, c.height - 4, 40, 3, this.accent);

    if (now < this.volumeShownUntil) {
      c.roundRect(c.width - 44, 120, 28, 180, 10, [30, 41, 59]);
      const h = (this.volume / 15) * 160;
      c.roundRect(c.width - 38, 290 - h, 16, h, 6, WHITE);
    }

    // Touch trail
    this.trail = this.trail.filter((t) => now - t.at < 600);
    for (const t of this.trail) {
      const age = (now - t.at) / 600;
      c.circle(t.x, t.y, 14 + age * 10, WHITE, 0.55 * (1 - age));
    }
    if (this.trail.length) this.dirty = true;
    return c;
  }

  private renderHome(c: Canvas): void {
    const [r, g, b] = this.accent;
    // Vertical gradient wallpaper
    for (let y = 0; y < c.height; y += 8) {
      const t = y / c.height;
      c.rect(0, y, c.width, 8, [
        Math.round(r * (1 - t) + 15 * t),
        Math.round(g * (1 - t) + 23 * t),
        Math.round(b * (1 - t) + 42 * t),
      ]);
    }
    c.textCentered(this.model, c.width / 2, 48, WHITE, 2);
    c.textCentered('DeviceLab mock device', c.width / 2, 80, [226, 232, 240]);
    for (const ic of this.iconLayout()) {
      c.roundRect(ic.x, ic.y, ic.size, ic.size, ic.size / 4, ic.app.color);
      c.textCentered(
        ic.app.label.slice(0, 1).toUpperCase(),
        ic.x + ic.size / 2,
        ic.y + ic.size / 2 - 13,
        WHITE,
        2,
      );
      c.textCentered(ic.app.label.slice(0, 9), ic.x + ic.size / 2, ic.y + ic.size + 4, WHITE);
    }
    if (this.platform === 'IOS') c.roundRect(c.width / 2 - 60, c.height - 16, 120, 5, 3, WHITE);
    else c.textCentered('<   O   []', c.width / 2, c.height - 30, [226, 232, 240]);
  }

  private renderApp(c: Canvas, app: MockApp): void {
    c.fill([248, 250, 252]);

    // Scrollable list (drawn first; the header and text field are painted over it)
    const top = 194;
    const rowH = 56;
    const first = Math.max(0, Math.floor(this.scrollY / rowH) - 1);
    for (let i = first; i < first + Math.ceil((c.height - top) / rowH) + 2; i++) {
      const y = top + i * rowH - this.scrollY;
      c.rect(0, y, c.width, rowH - 1, i % 2 ? [241, 245, 249] : WHITE);
      c.circle(36, y + rowH / 2, 16, app.color, 0.85);
      c.text(`Transaction #${1000 + i}`, 64, y + 12, DARK);
      c.text(`INR ${((i * 7919) % 50000) / 100}`, 64, y + 30, MUTED);
    }

    c.rect(0, 0, c.width, top, [248, 250, 252]);
    c.rect(0, 0, c.width, 70, app.color);
    c.text('< Back', 12, 40, WHITE);
    c.text(app.label, 90, 40, WHITE);

    // Text field
    c.roundRect(16, 86, c.width - 32, 92, 8, WHITE);
    c.rect(16, 176, c.width - 32, 2, app.color);
    const lines = (this.typed || 'Type with your keyboard...').split('\n').slice(-5);
    lines.forEach((line, i) =>
      c.text(
        line.slice(-Math.floor((c.width - 48) / 8)),
        24,
        94 + i * 16,
        this.typed ? DARK : MUTED,
      ),
    );
  }
}
