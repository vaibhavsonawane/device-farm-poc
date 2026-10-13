import type { Frame } from '@devicelab/protocol';
import type {
  AppInfo,
  DeviceHealth,
  DeviceReport,
  LogLine,
  Platform,
  StreamQuality,
  StreamStatus,
} from '@devicelab/shared-types';

/** Callbacks a driver uses to report device presence and health to the server link. */
export interface DriverEvents {
  onDevice(report: DeviceReport): void;
  onRemoved(serial: string): void;
  onHealth(health: DeviceHealth): void;
}

/** Where a running stream sends encoded frames and status. */
export interface StreamSink {
  sendFrame(frame: Uint8Array): void;
  status(state: StreamStatus['state'], message?: string, secureContentSuspected?: boolean): void;
}

/** A live screen stream for one device. */
export interface StreamHandle {
  /** Input frames from the controlling viewer (TOUCH, KEY, TEXT, SCROLL, CLIPBOARD, ROTATE). */
  handleInput(frame: Frame): void;
  requestKeyframe(): void;
  setQuality(quality: StreamQuality): Promise<void>;
  stop(): Promise<void>;
}

export interface CleanupOptions {
  uninstallPackages: string[];
  reboot: boolean;
}

export type InstallProgressFn = (percent: number, message?: string) => void;

/**
 * Strategy interface implemented per platform (AndroidDriver, IosDriver, MockDriver).
 * Every method takes the device serial/UDID; drivers own only the devices they discovered.
 */
export interface DeviceDriver {
  readonly name: string;
  readonly platforms: readonly Platform[];
  start(events: DriverEvents): Promise<void>;
  stop(): Promise<void>;
  /** Re-report every device (after reconnect or an admin "Re-sync"). */
  resync(): Promise<void>;
  owns(serial: string): boolean;
  startStream(serial: string, quality: StreamQuality, sink: StreamSink): Promise<StreamHandle>;
  /** Install a local APK/IPA. Resolves with the package/bundle ids that were added or updated. */
  install(serial: string, filePath: string, onProgress: InstallProgressFn): Promise<string[]>;
  listApps(serial: string): Promise<AppInfo[]>;
  appAction(
    serial: string,
    packageId: string,
    action: 'launch' | 'stop' | 'clear' | 'uninstall',
  ): Promise<void>;
  screenshot(serial: string): Promise<Buffer>;
  /** Start streaming device logs; returns a function that stops it. */
  startLogs(serial: string, onLines: (lines: LogLine[]) => void): Promise<() => void>;
  cleanup(serial: string, opts: CleanupOptions): Promise<void>;
  reboot(serial: string): Promise<void>;
}

export class DriverError extends Error {}
