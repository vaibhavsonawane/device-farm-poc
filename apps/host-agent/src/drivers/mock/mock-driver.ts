import { type Frame, FrameType, TouchAction } from '@devicelab/protocol';
import type { AppInfo, DeviceReport, LogLine, StreamQuality } from '@devicelab/shared-types';
import path from 'node:path';
import { type Logger } from '../../logger';
import {
  type CleanupOptions,
  type DeviceDriver,
  type DriverEvents,
  type InstallProgressFn,
  type StreamHandle,
  type StreamSink,
} from '../driver';
import { type RGB } from './canvas';
import { type FrameEncoder, H264Encoder, MjpegEncoder, hasFfmpeg } from './encoders';
import { type MockApp, MockScreen } from './mock-screen';

interface MockSpec {
  serial: string;
  platform: 'ANDROID' | 'IOS';
  model: string;
  manufacturer: string;
  osVersion: string;
  screenW: number;
  screenH: number;
  /** Rendered frame size (even numbers, kept small to save CPU). */
  frameW: number;
  frameH: number;
  accent: RGB;
}

const SPECS: MockSpec[] = [
  {
    serial: 'MOCK-PIXEL8-01',
    platform: 'ANDROID',
    model: 'Pixel 8',
    manufacturer: 'Google',
    osVersion: '14',
    screenW: 1080,
    screenH: 2400,
    frameW: 432,
    frameH: 960,
    accent: [37, 99, 235],
  },
  {
    serial: 'MOCK-GALAXYS23-02',
    platform: 'ANDROID',
    model: 'Galaxy S23',
    manufacturer: 'Samsung',
    osVersion: '14',
    screenW: 1080,
    screenH: 2340,
    frameW: 432,
    frameH: 936,
    accent: [13, 148, 136],
  },
  {
    serial: 'MOCK-REDMI12-03',
    platform: 'ANDROID',
    model: 'Redmi Note 12',
    manufacturer: 'Xiaomi',
    osVersion: '13',
    screenW: 1080,
    screenH: 2400,
    frameW: 432,
    frameH: 960,
    accent: [234, 88, 12],
  },
  {
    serial: '00008110-MOCKIPHONE15',
    platform: 'IOS',
    model: 'iPhone 15',
    manufacturer: 'Apple',
    osVersion: '17.4',
    screenW: 1179,
    screenH: 2556,
    frameW: 390,
    frameH: 844,
    accent: [79, 70, 229],
  },
  {
    serial: '00008030-MOCKIPHONE13',
    platform: 'IOS',
    model: 'iPhone 13',
    manufacturer: 'Apple',
    osVersion: '16.7',
    screenW: 1170,
    screenH: 2532,
    frameW: 390,
    frameH: 844,
    accent: [190, 24, 93],
  },
];

function systemApps(platform: 'ANDROID' | 'IOS'): MockApp[] {
  const p = platform === 'ANDROID' ? 'com.android' : 'com.apple';
  return [
    { packageId: `${p}.settings`, label: 'Settings', color: [100, 116, 139], system: true },
    { packageId: `${p}.camera`, label: 'Camera', color: [51, 65, 85], system: true },
    { packageId: `${p}.browser`, label: 'Browser', color: [14, 165, 233], system: true },
    { packageId: `${p}.messages`, label: 'Messages', color: [34, 197, 94], system: true },
    { packageId: 'in.devicelab.demo.upi', label: 'UPI Pay', color: [124, 58, 237], system: false },
    {
      packageId: 'in.devicelab.demo.securebank',
      label: 'SecureBank',
      color: [220, 38, 38],
      system: false,
      secure: true,
    },
  ];
}

class MockDevice {
  readonly screen: MockScreen;
  battery = 60 + Math.floor(Math.random() * 40);
  online = true;
  streams = new Set<MockStream>();

  constructor(readonly spec: MockSpec) {
    this.screen = new MockScreen(
      spec.frameW,
      spec.frameH,
      spec.model,
      spec.accent,
      spec.platform,
      systemApps(spec.platform),
      () => this.battery,
    );
  }

  report(): DeviceReport {
    return {
      serial: this.spec.serial,
      platform: this.spec.platform,
      state: this.online ? 'online' : 'offline',
      model: this.spec.model,
      manufacturer: this.spec.manufacturer,
      osVersion: this.spec.osVersion,
      screenW: this.spec.screenW,
      screenH: this.spec.screenH,
      batteryLevel: this.battery,
      temperatureC: 31 + Math.round(Math.random() * 40) / 10,
      network: 'Wi-Fi (LabNet)',
      storageFreeMb: 41_200,
      storageTotalMb: 128_000,
    };
  }
}

class MockStream implements StreamHandle {
  private encoder: FrameEncoder;
  private timer: NodeJS.Timeout | null = null;
  private lastPush = 0;
  private wasSecure = false;
  private size: { w: number; h: number };

  constructor(
    private readonly device: MockDevice,
    private quality: StreamQuality,
    private readonly sink: StreamSink,
    private readonly log: Logger,
  ) {
    this.size = { w: device.screen.width, h: device.screen.height };
    this.encoder = this.makeEncoder();
    this.schedule();
    sink.status(
      'streaming',
      this.encoder instanceof H264Encoder ? 'H.264 (mock, ffmpeg)' : 'MJPEG (mock)',
    );
  }

  /** MOCK_VIDEO=mjpeg forces MJPEG (for browsers without H.264, e.g. open-source Chromium in CI). */
  private get useH264(): boolean {
    return (
      this.device.spec.platform === 'ANDROID' && process.env.MOCK_VIDEO !== 'mjpeg' && hasFfmpeg()
    );
  }

  private makeEncoder(): FrameEncoder {
    const { w, h } = this.size;
    if (this.useH264) {
      return new H264Encoder(
        w,
        h,
        this.fps,
        this.quality.bitRate,
        (f) => this.sink.sendFrame(f),
        (msg) => this.log.warn({ msg }, 'mock ffmpeg'),
      );
    }
    return new MjpegEncoder(70, (f) => this.sink.sendFrame(f));
  }

  private get fps(): number {
    // MJPEG encoding in JS is expensive; cap it.
    return this.useH264 ? Math.min(this.quality.maxFps, 30) : Math.min(this.quality.maxFps, 12);
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), Math.round(1000 / this.fps));
  }

  private tick(): void {
    const screen = this.device.screen;
    if (screen.width !== this.size.w || screen.height !== this.size.h) {
      // Rotation: restart the encoder at the new size (new SPS → VIDEO_CONFIG).
      this.encoder.close();
      this.size = { w: screen.width, h: screen.height };
      this.encoder = this.makeEncoder();
    }
    const now = Date.now();
    // H.264 wants a steady frame rate; MJPEG only when something changed (plus a 1 s keep-alive).
    if (!this.useH264 && !screen.dirty && now - this.lastPush < 1000) return;
    screen.dirty = false;
    this.lastPush = now;
    this.encoder.push(screen.render());
    if (screen.secureVisible !== this.wasSecure) {
      this.wasSecure = screen.secureVisible;
      this.sink.status(
        'streaming',
        this.wasSecure ? 'Secure content (FLAG_SECURE)' : undefined,
        this.wasSecure,
      );
    }
  }

  handleInput(frame: Frame): void {
    const s = this.device.screen;
    switch (frame.type) {
      case FrameType.TOUCH:
        if (frame.pointerId === 0)
          s.touch(
            frame.action === TouchAction.CANCEL ? TouchAction.UP : frame.action,
            frame.x,
            frame.y,
          );
        break;
      case FrameType.KEY:
        s.key(frame.key, frame.action === 0);
        break;
      case FrameType.TEXT:
        s.typeText(frame.text);
        break;
      case FrameType.CLIPBOARD:
        if (frame.paste) s.typeText(frame.text);
        break;
      case FrameType.SCROLL:
        s.scroll(frame.dy);
        break;
      case FrameType.ROTATE:
        s.rotate();
        break;
      default:
        break;
    }
  }

  requestKeyframe(): void {
    this.device.screen.dirty = true;
    this.encoder.requestKeyframe();
  }

  async setQuality(quality: StreamQuality): Promise<void> {
    this.quality = quality;
    this.encoder.close();
    this.encoder = this.makeEncoder();
    this.schedule();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.encoder.close();
    this.device.streams.delete(this);
  }
}

const LOG_TAGS = [
  'ActivityManager',
  'NetworkController',
  'OkHttp',
  'UPI-SDK',
  'chromium',
  'BatteryService',
  'PackageManager',
];
const LOG_MESSAGES = [
  'GET /api/v1/accounts 200 (84ms)',
  'POST /api/v1/upi/collect 202 (131ms)',
  'Displayed in.devicelab.demo.upi/.MainActivity: +412ms',
  'Background concurrent copying GC freed 5120KB',
  'Wi-Fi RSSI -54 dBm',
  'TLS handshake completed with lab-gateway.local',
  'onResume()',
  'Token refresh scheduled in 600s',
];

/** Simulated devices for portal development and demos (`--mock`). */
export class MockDriver implements DeviceDriver {
  readonly name = 'mock';
  readonly platforms = ['ANDROID', 'IOS'] as const;
  private readonly devices = new Map<string, MockDevice>();
  private events: DriverEvents | null = null;
  private batteryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly log: Logger) {
    for (const spec of SPECS) this.devices.set(spec.serial, new MockDevice(spec));
  }

  async start(events: DriverEvents): Promise<void> {
    this.events = events;
    if (!hasFfmpeg())
      this.log.warn('ffmpeg not found: mock Android devices will stream MJPEG instead of H.264');
    for (const d of this.devices.values()) events.onDevice(d.report());
    this.batteryTimer = setInterval(() => {
      for (const d of this.devices.values()) {
        d.battery = d.streams.size ? Math.max(5, d.battery - 1) : Math.min(100, d.battery + 1);
        if (d.online) events.onDevice(d.report());
      }
    }, 30_000);
  }

  async stop(): Promise<void> {
    if (this.batteryTimer) clearInterval(this.batteryTimer);
    for (const d of this.devices.values()) for (const s of [...d.streams]) await s.stop();
  }

  async resync(): Promise<void> {
    for (const d of this.devices.values()) this.events?.onDevice(d.report());
  }

  owns(serial: string): boolean {
    return this.devices.has(serial);
  }

  private get(serial: string): MockDevice {
    const d = this.devices.get(serial);
    if (!d) throw new Error(`unknown mock device ${serial}`);
    if (!d.online) throw new Error(`${d.spec.model} is offline`);
    return d;
  }

  async startStream(
    serial: string,
    quality: StreamQuality,
    sink: StreamSink,
  ): Promise<StreamHandle> {
    const d = this.get(serial);
    const stream = new MockStream(d, quality, sink, this.log.child({ serial }));
    d.streams.add(stream);
    return stream;
  }

  async install(
    serial: string,
    filePath: string,
    onProgress: InstallProgressFn,
  ): Promise<string[]> {
    const d = this.get(serial);
    const base = path
      .basename(filePath)
      .replace(/\.(apk|ipa)$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
    const packageId = `com.devicelab.mock.${base || 'app'}`;
    for (const p of [20, 45, 70, 95]) {
      onProgress(p, p < 95 ? 'Installing…' : 'Optimising…');
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!d.screen.apps.some((a) => a.packageId === packageId)) {
      const hue = [...base].reduce((h, c) => h + c.charCodeAt(0), 0);
      d.screen.apps.push({
        packageId,
        label: base.slice(0, 10) || 'App',
        color: [80 + (hue % 120), 60 + ((hue * 7) % 120), 140 + ((hue * 13) % 100)],
        system: false,
      });
      d.screen.dirty = true;
    }
    d.screen.events.push(`PackageManager: installed ${packageId}`);
    return [packageId];
  }

  async listApps(serial: string): Promise<AppInfo[]> {
    return this.get(serial).screen.apps.map((a) => ({
      packageId: a.packageId,
      label: a.label,
      versionName: a.system ? null : '1.0.0',
      system: a.system,
    }));
  }

  async appAction(
    serial: string,
    packageId: string,
    action: 'launch' | 'stop' | 'clear' | 'uninstall',
  ): Promise<void> {
    const s = this.get(serial).screen;
    const app = s.apps.find((a) => a.packageId === packageId);
    if (!app) throw new Error(`${packageId} is not installed`);
    if (action === 'launch') s.launch(packageId);
    else if (action === 'stop') s.home();
    else if (action === 'uninstall') {
      if (app.system) throw new Error('system apps cannot be uninstalled');
      s.home();
      s.apps.splice(s.apps.indexOf(app), 1);
      s.dirty = true;
    }
    s.events.push(`ActivityManager: ${action} ${packageId}`);
  }

  async screenshot(serial: string): Promise<Buffer> {
    return this.get(serial).screen.render().toPng();
  }

  async startLogs(serial: string, onLines: (lines: LogLine[]) => void): Promise<() => void> {
    const d = this.get(serial);
    let pid = 4000 + Math.floor(Math.random() * 3000);
    const timer = setInterval(() => {
      const lines: LogLine[] = d.screen.events.splice(0).map((message) => ({
        ts: Date.now(),
        level: 'I',
        tag: message.split(':')[0] ?? 'System',
        pid,
        tid: pid,
        message: message.split(': ').slice(1).join(': ') || message,
      }));
      if (Math.random() < 0.7) {
        const r = Math.random();
        lines.push({
          ts: Date.now(),
          level: r < 0.05 ? 'E' : r < 0.15 ? 'W' : r < 0.6 ? 'D' : 'I',
          tag: LOG_TAGS[Math.floor(Math.random() * LOG_TAGS.length)]!,
          pid: pid++,
          tid: pid,
          message: LOG_MESSAGES[Math.floor(Math.random() * LOG_MESSAGES.length)]!,
        });
      }
      if (lines.length) onLines(lines);
    }, 300);
    return () => clearInterval(timer);
  }

  async cleanup(serial: string, opts: CleanupOptions): Promise<void> {
    const d = this.devices.get(serial);
    if (!d) return;
    for (const s of [...d.streams]) await s.stop();
    d.screen.apps.splice(
      0,
      d.screen.apps.length,
      ...d.screen.apps.filter((a) => a.system || !opts.uninstallPackages.includes(a.packageId)),
    );
    d.screen.reset();
    if (opts.reboot) await this.reboot(serial);
  }

  async reboot(serial: string): Promise<void> {
    const d = this.devices.get(serial);
    if (!d) throw new Error('unknown device');
    d.online = false;
    for (const s of [...d.streams]) await s.stop();
    this.events?.onDevice(d.report());
    setTimeout(() => {
      d.online = true;
      d.screen.reset();
      this.events?.onDevice(d.report());
    }, 4000);
  }
}
