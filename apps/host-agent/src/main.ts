#!/usr/bin/env node
// DeviceLab Host Agent — Crafted by Vaibhav Sonawane through Claude
import os from 'node:os';
import { loadConfig, parseArgs } from './config';
import { DeviceManager } from './device-manager';
import { runDoctor } from './doctor';
import { AndroidDriver } from './drivers/android/android-driver';
import { type DeviceDriver } from './drivers/driver';
import { IosDriver } from './drivers/ios/ios-driver';
import { MockDriver } from './drivers/mock/mock-driver';
import { startHealthServer } from './health';
import { logger } from './logger';
import { ServerLink } from './server-link';
import { AGENT_VERSION } from './version';

const SIGNATURE = 'Crafted by Vaibhav Sonawane through Claude';

const HELP = `DeviceLab Host Agent ${AGENT_VERSION}

Usage: devicelab-agent [--config agent.config.json] [--mock]
       devicelab-agent --doctor [serial]   Diagnose adb, scrcpy-server and screen streaming

  -c, --config <file>  Config file (default: ./agent.config.json or $DEVICELAB_AGENT_CONFIG)
      --mock           Simulate 3 Android + 2 iOS devices (no phones needed)
  -v, --version        Print version
  -h, --help           Show this help

Environment overrides: DEVICELAB_SERVER_URL, DEVICELAB_AGENT_TOKEN, DEVICELAB_HOST_NAME, LOG_LEVEL
`;

function banner(mode: string, serverUrl: string, hostName: string): void {
  const dim = (s: string): string => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
  process.stderr.write(
    [
      '',
      '  ┌──────────────────────────────────────────┐',
      `  │  DeviceLab Host Agent  v${AGENT_VERSION.padEnd(17)}│`,
      '  └──────────────────────────────────────────┘',
      `  host   ${hostName} (${os.platform()}/${os.arch()})`,
      `  mode   ${mode}`,
      `  server ${serverUrl}`,
      `  ${dim(SIGNATURE)}`,
      '',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.version) {
    process.stdout.write(`devicelab-agent ${AGENT_VERSION}\n${SIGNATURE}\n`);
    return;
  }
  const cfg = loadConfig(args);
  if (args.doctor) {
    process.exitCode = await runDoctor(cfg, args.doctorSerial);
    return;
  }
  logger.level = process.env.LOG_LEVEL ?? cfg.logLevel;

  const drivers: DeviceDriver[] = [];
  if (cfg.mock) {
    drivers.push(new MockDriver(logger.child({ driver: 'mock' })));
  } else {
    drivers.push(new AndroidDriver(cfg, logger.child({ driver: 'android' })));
    // iOS devices can only be driven from macOS (Xcode / WebDriverAgent).
    if (os.platform() === 'darwin')
      drivers.push(new IosDriver(cfg, logger.child({ driver: 'ios' })));
  }
  banner(
    cfg.mock ? 'mock (3 Android + 2 iOS simulated)' : drivers.map((d) => d.name).join(' + '),
    cfg.serverUrl,
    cfg.hostName,
  );

  const manager = new DeviceManager(cfg, drivers, logger);
  const link = new ServerLink(cfg, manager, logger);
  await manager.start(link);
  link.start();
  const health = startHealthServer(cfg.healthPort, link, manager);
  health.on('error', (err) =>
    logger.warn({ err: err.message, port: cfg.healthPort }, 'health endpoint unavailable'),
  );
  logger.info(
    { port: cfg.healthPort },
    'health endpoint on http://127.0.0.1:%d/health',
    cfg.healthPort,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await manager.stop().catch(() => undefined);
    link.stop();
    health.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: Error) => {
  logger.fatal({ err: err.message }, 'agent failed to start');
  process.exit(1);
});
