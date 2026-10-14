import type { AppInfo, DeviceReport, LogLine, StreamQuality } from '@devicelab/shared-types';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { type AgentConfig } from '../../config';
import { type Logger } from '../../logger';
import {
  type CleanupOptions,
  type DeviceDriver,
  type DriverEvents,
  type InstallProgressFn,
  type StreamHandle,
  type StreamSink,
} from '../driver';
import { AdbBridge, shq } from './adb';
import {
  diffInstalled,
  parseBattery,
  parseDf,
  parseLogcatLine,
  parsePackageList,
  parseWmSize,
} from './parsers';
import { DEVICE_JAR_PATH, ScrcpySession } from './scrcpy-session';

type AdbState = 'device' | 'emulator' | 'offline' | 'unauthorized' | 'unknown';

interface Known {
  state: AdbState;
  report: DeviceReport | null;
  jarPushed: boolean;
}

const POLL_MS = 60_000;

/** Android devices via ADB + scrcpy-server. Works on Linux, macOS and Windows hosts. */
export class AndroidDriver implements DeviceDriver {
  readonly name = 'android';
  readonly platforms = ['ANDROID'] as const;
  private readonly adb: AdbBridge;
  private readonly devices = new Map<string, Known>();
  private readonly sessions = new Map<string, ScrcpySession>();
  private events: DriverEvents | null = null;
  private tracker: { end(): unknown; on(ev: string, fn: (...a: never[]) => void): unknown } | null =
    null;
  private poll: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly cfg: AgentConfig,
    private readonly log: Logger,
  ) {
    this.adb = new AdbBridge({ host: cfg.adbHost, port: cfg.adbPort, bin: cfg.adbPath });
  }

  async start(events: DriverEvents): Promise<void> {
    this.events = events;
    if (!existsSync(this.cfg.scrcpyServerPath)) {
      this.log.warn(
        { path: this.cfg.scrcpyServerPath },
        'scrcpy-server not found — run `pnpm --filter @devicelab/host-agent fetch:scrcpy`; streaming will fail',
      );
    }
    await this.track();
    this.poll = setInterval(() => void this.refreshAll(), POLL_MS);
  }

  /** `adb track-devices` with automatic re-subscription if the adb server restarts. */
  private async track(): Promise<void> {
    try {
      const tracker = await this.adb.client.trackDevices();
      this.tracker = tracker as unknown as typeof this.tracker;
      tracker.on('add', (d: { id: string; type: AdbState }) => void this.onState(d.id, d.type));
      tracker.on('change', (d: { id: string; type: AdbState }) => void this.onState(d.id, d.type));
      tracker.on('remove', (d: { id: string }) => this.onRemove(d.id));
      tracker.on('end', () => this.retrack('tracker ended'));
      tracker.on('error', (err: Error) => this.retrack(err.message));
      for (const d of await this.adb.client.listDevices())
        await this.onState(d.id, d.type as AdbState);
    } catch (err) {
      this.retrack((err as Error).message);
    }
  }

  private retrack(reason: string): void {
    if (this.stopped) return;
    this.log.warn({ reason }, 'adb tracker lost; retrying in 3 s (is the adb server running?)');
    setTimeout(() => void this.track(), 3000);
  }

  private async onState(serial: string, state: AdbState): Promise<void> {
    const known = this.devices.get(serial) ?? { state, report: null, jarPushed: false };
    known.state = state;
    this.devices.set(serial, known);
    if (state === 'device' || state === 'emulator') {
      try {
        known.report = await this.probe(serial);
        this.events?.onDevice(known.report);
      } catch (err) {
        this.log.warn({ serial, err: (err as Error).message }, 'probe failed');
        this.events?.onHealth({
          serial,
          level: 'error',
          message: `Cannot read device properties: ${(err as Error).message}`,
        });
      }
    } else {
      this.events?.onDevice({
        serial,
        platform: 'ANDROID',
        state: state === 'unauthorized' ? 'unauthorized' : 'offline',
        model: known.report?.model ?? '',
        manufacturer: known.report?.manufacturer ?? '',
        osVersion: known.report?.osVersion ?? '',
        screenW: known.report?.screenW ?? 0,
        screenH: known.report?.screenH ?? 0,
        batteryLevel: known.report?.batteryLevel ?? null,
      });
    }
  }

  private onRemove(serial: string): void {
    this.devices.delete(serial);
    const s = this.sessions.get(serial);
    if (s) void s.stop();
    this.sessions.delete(serial);
    this.events?.onRemoved(serial);
  }

  private async probe(serial: string): Promise<DeviceReport> {
    const props = await this.adb.getProperties(serial);
    const [wm, battery, df] = await Promise.all([
      this.adb.shell(serial, 'wm size').catch(() => ''),
      this.adb.shell(serial, 'dumpsys battery').catch(() => ''),
      this.adb.shell(serial, 'df /data').catch(() => ''),
    ]);
    const size = parseWmSize(wm);
    const batt = parseBattery(battery);
    const storage = parseDf(df);
    return {
      serial,
      platform: 'ANDROID',
      state: 'online',
      model: props['ro.product.model'] ?? 'Android device',
      manufacturer: props['ro.product.manufacturer'] ?? 'Unknown',
      osVersion: props['ro.build.version.release'] ?? '?',
      screenW: size?.width ?? 0,
      screenH: size?.height ?? 0,
      batteryLevel: batt.level,
      temperatureC: batt.temperatureC,
      network: props['gsm.operator.alpha'] ? `SIM: ${props['gsm.operator.alpha']}` : null,
      storageFreeMb: storage?.freeMb ?? null,
      storageTotalMb: storage?.totalMb ?? null,
    };
  }

  private async refreshAll(): Promise<void> {
    for (const [serial, k] of this.devices) {
      if (k.state !== 'device' && k.state !== 'emulator') continue;
      try {
        k.report = await this.probe(serial);
        this.events?.onDevice(k.report);
      } catch {
        /* next poll */
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    this.tracker?.end();
    for (const s of this.sessions.values()) await s.stop();
    this.sessions.clear();
  }

  async resync(): Promise<void> {
    for (const [serial, k] of this.devices) await this.onState(serial, k.state);
  }

  owns(serial: string): boolean {
    return this.devices.has(serial);
  }

  private ready(serial: string): Known {
    const k = this.devices.get(serial);
    if (!k) throw new Error(`device ${serial} not connected`);
    if (k.state === 'unauthorized') throw new Error('USB debugging not authorised on the device');
    if (k.state !== 'device' && k.state !== 'emulator') throw new Error(`device is ${k.state}`);
    return k;
  }

  private async ensureJar(serial: string, k: Known): Promise<void> {
    if (k.jarPushed) return;
    if (!existsSync(this.cfg.scrcpyServerPath))
      throw new Error(`scrcpy-server missing at ${this.cfg.scrcpyServerPath}`);
    await this.adb.push(serial, this.cfg.scrcpyServerPath, DEVICE_JAR_PATH);
    k.jarPushed = true;
  }

  async startStream(
    serial: string,
    quality: StreamQuality,
    sink: StreamSink,
  ): Promise<StreamHandle> {
    const k = this.ready(serial);
    await this.ensureJar(serial, k);
    await this.sessions.get(serial)?.stop();
    const session = new ScrcpySession(
      this.adb,
      serial,
      quality,
      sink,
      this.log.child({ serial }),
      this.cfg.scrcpyCodecOptions,
    );
    try {
      await session.start();
    } catch (err) {
      await session.stop(); // remove the adb forward and kill the server process
      throw err;
    }
    this.sessions.set(serial, session);
    const stop = session.stop.bind(session);
    session.stop = async () => {
      if (this.sessions.get(serial) === session) this.sessions.delete(serial);
      await stop();
    };
    return session;
  }

  private async thirdPartyPackages(serial: string): Promise<string[]> {
    return parsePackageList(await this.adb.shell(serial, 'pm list packages -3 -f'));
  }

  async install(
    serial: string,
    filePath: string,
    onProgress: InstallProgressFn,
  ): Promise<string[]> {
    this.ready(serial);
    const before = await this.thirdPartyPackages(serial);
    const remote = `/data/local/tmp/devicelab-${randomBytes(6).toString('hex')}.apk`;
    onProgress(10, 'Pushing APK to device…');
    await this.adb.push(serial, filePath, remote);
    try {
      onProgress(40, 'Installing (pm install -r -g)…');
      const out = await this.adb.shell(serial, `pm install -r -g -t ${shq(remote)}`, 5 * 60_000);
      if (!/Success/.test(out)) {
        const reason = /Failure \[([^\]]+)\]/.exec(out)?.[1] ?? out.trim().slice(0, 300);
        throw new Error(`install failed: ${reason}`);
      }
    } finally {
      await this.adb.shell(serial, `rm -f ${shq(remote)}`).catch(() => undefined);
    }
    onProgress(100);
    return diffInstalled(before, await this.thirdPartyPackages(serial));
  }

  async listApps(serial: string): Promise<AppInfo[]> {
    this.ready(serial);
    const pkgs = parsePackageList(await this.adb.shell(serial, 'pm list packages -3'));
    return pkgs
      .sort()
      .map((packageId) => ({ packageId, label: null, versionName: null, system: false }));
  }

  async appAction(
    serial: string,
    packageId: string,
    action: 'launch' | 'stop' | 'clear' | 'uninstall',
  ): Promise<void> {
    this.ready(serial);
    const pkg = shq(packageId);
    const cmd = {
      launch: `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`,
      stop: `am force-stop ${pkg}`,
      clear: `pm clear ${pkg}`,
      uninstall: `pm uninstall ${pkg}`,
    }[action];
    const out = await this.adb.shell(serial, cmd, 60_000);
    if (action === 'uninstall' && !/Success/.test(out))
      throw new Error(`uninstall failed: ${out.trim().slice(0, 200)}`);
    if (action === 'clear' && !/Success/.test(out))
      throw new Error(`clear failed: ${out.trim().slice(0, 200)}`);
    if (action === 'launch' && /No activities found/.test(out))
      throw new Error('app has no launcher activity');
  }

  async screenshot(serial: string): Promise<Buffer> {
    this.ready(serial);
    return this.adb.screencap(serial);
  }

  async startLogs(serial: string, onLines: (lines: LogLine[]) => void): Promise<() => void> {
    this.ready(serial);
    const stream = await this.adb.shellStream(serial, 'logcat -v threadtime -T 200');
    let partial = '';
    stream.on('data', (d: Buffer) => {
      const text = partial + d.toString('utf8');
      const parts = text.split(/\r?\n/);
      partial = parts.pop() ?? '';
      const lines = parts.map((l) => parseLogcatLine(l)).filter((l): l is LogLine => l !== null);
      if (lines.length) onLines(lines);
    });
    stream.on('error', () => undefined);
    return () => stream.end();
  }

  async cleanup(serial: string, opts: CleanupOptions): Promise<void> {
    if (!this.devices.has(serial)) return;
    const session = this.sessions.get(serial);
    session?.clearClipboard();
    await session?.stop();
    for (const pkg of opts.uninstallPackages) {
      if (!/^[a-zA-Z0-9._-]+$/.test(pkg)) continue;
      const out = await this.adb
        .shell(serial, `pm uninstall ${shq(pkg)}`)
        .catch((e: Error) => e.message);
      this.log.info({ serial, pkg, out: out.trim() }, 'cleanup uninstall');
    }
    await this.adb.shell(serial, 'input keyevent KEYCODE_HOME').catch(() => undefined);
    if (opts.reboot) await this.reboot(serial);
  }

  async reboot(serial: string): Promise<void> {
    this.ready(serial);
    await this.adb.reboot(serial);
  }
}
