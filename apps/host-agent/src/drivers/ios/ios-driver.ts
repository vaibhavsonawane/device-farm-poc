import type { AppInfo, LogLine, StreamQuality } from '@devicelab/shared-types';
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

const PHASE2 =
  'iOS support arrives in Phase 2 (go-ios + WebDriverAgent). See docs/HOST_SETUP_IOS.md.';

/**
 * Placeholder for Phase 2. The DeviceDriver contract is final: go-ios for
 * discovery/install/syslog/forwarding and WebDriverAgent for input + MJPEG.
 * Only enabled on macOS hosts.
 */
export class IosDriver implements DeviceDriver {
  readonly name = 'ios';
  readonly platforms = ['IOS'] as const;

  constructor(
    private readonly cfg: AgentConfig,
    private readonly log: Logger,
  ) {}

  async start(_events: DriverEvents): Promise<void> {
    this.log.info({ goIos: this.cfg.goIosPath }, PHASE2);
  }
  async stop(): Promise<void> {}
  async resync(): Promise<void> {}
  owns(_serial: string): boolean {
    return false;
  }
  startStream(_serial: string, _q: StreamQuality, _sink: StreamSink): Promise<StreamHandle> {
    return Promise.reject(new Error(PHASE2));
  }
  install(_serial: string, _file: string, _p: InstallProgressFn): Promise<string[]> {
    return Promise.reject(new Error(PHASE2));
  }
  listApps(_serial: string): Promise<AppInfo[]> {
    return Promise.reject(new Error(PHASE2));
  }
  appAction(): Promise<void> {
    return Promise.reject(new Error(PHASE2));
  }
  screenshot(_serial: string): Promise<Buffer> {
    return Promise.reject(new Error(PHASE2));
  }
  startLogs(_serial: string, _onLines: (l: LogLine[]) => void): Promise<() => void> {
    return Promise.reject(new Error(PHASE2));
  }
  cleanup(_serial: string, _opts: CleanupOptions): Promise<void> {
    return Promise.reject(new Error(PHASE2));
  }
  reboot(_serial: string): Promise<void> {
    return Promise.reject(new Error(PHASE2));
  }
}
