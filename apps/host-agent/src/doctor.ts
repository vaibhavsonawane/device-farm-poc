import { FrameType, decodeFrame } from '@devicelab/protocol';
import { STREAM_QUALITY_PRESETS } from '@devicelab/shared-types';
import pino from 'pino';
import { type AgentConfig } from './config';
import { AdbBridge, withTimeout } from './drivers/android/adb';
import { ensureDeviceJar, makeLaunchCopy, removeLaunchCopy } from './drivers/android/device-jar';
import { ScrcpySession } from './drivers/android/scrcpy-session';
import { deviceCrashLog, scrcpyStartupProbe } from './drivers/android/diagnostics';
import { checkScrcpyJar } from './drivers/android/scrcpy-jar';
import { AGENT_VERSION } from './version';

const ok = (msg: string): void => void process.stdout.write(`  \x1b[32m✔\x1b[0m ${msg}\n`);
const bad = (msg: string): void => void process.stdout.write(`  \x1b[31m✖\x1b[0m ${msg}\n`);
const info = (msg: string): void => void process.stdout.write(`    ${msg}\n`);

/**
 * `devicelab-agent --doctor [serial]` — runs the same steps as a live session
 * (outside the portal) and reports exactly which one fails. Exit code 1 on failure.
 */
export async function runDoctor(cfg: AgentConfig, serial: string | null): Promise<number> {
  let failures = 0;
  process.stdout.write(`\nDeviceLab agent doctor (agent ${AGENT_VERSION})\n\n`);

  // 1. Server
  try {
    const res = await withTimeout(fetch(new URL('/api/health', cfg.serverUrl)), 8000, 'timed out');
    if (res.ok) ok(`server reachable: ${cfg.serverUrl}`);
    else {
      failures++;
      bad(`server ${cfg.serverUrl} answered HTTP ${res.status}`);
    }
  } catch (err) {
    failures++;
    bad(`cannot reach server ${cfg.serverUrl}: ${(err as Error).message}`);
    info('check serverUrl, DNS/firewall, and caFile / NODE_EXTRA_CA_CERTS for internal TLS');
  }

  // 2. scrcpy-server jar
  const jarProblem = checkScrcpyJar(cfg.scrcpyServerPath);
  if (jarProblem) {
    failures++;
    bad(jarProblem);
  } else ok(`scrcpy-server v3.3.4 present: ${cfg.scrcpyServerPath}`);

  // 3. adb + devices
  const adb = new AdbBridge({ host: cfg.adbHost, port: cfg.adbPort, bin: cfg.adbPath });
  let devices: { id: string; type: string }[] = [];
  try {
    devices = await withTimeout(adb.client.listDevices(), 10_000, 'timed out');
    ok(`adb server reachable (${cfg.adbHost}:${cfg.adbPort}), ${devices.length} device(s)`);
    for (const d of devices)
      info(
        `${d.id}  ${d.type}${d.type === 'unauthorized' ? '  ← accept the USB debugging prompt' : ''}`,
      );
  } catch (err) {
    failures++;
    bad(`adb not reachable: ${(err as Error).message} — run \`${cfg.adbPath} start-server\``);
    return 1;
  }

  const targets = devices.filter((d) => (serial ? d.id === serial : d.type === 'device'));
  if (!targets.length) {
    bad(serial ? `device ${serial} not found or not authorised` : 'no authorised device to test');
    return 1;
  }
  if (jarProblem) return 1;

  // 4. Full stream start per device
  for (const d of targets) {
    process.stdout.write(`\n  ${d.id}\n`);
    try {
      const props = await adb.getProperties(d.id);
      ok(
        `${props['ro.product.manufacturer'] ?? '?'} ${props['ro.product.model'] ?? '?'}, Android ${props['ro.build.version.release'] ?? '?'} (SDK ${props['ro.build.version.sdk'] ?? '?'})`,
      );
      if (Number(props['ro.build.version.sdk'] ?? 99) < 21) {
        failures++;
        bad('scrcpy needs Android 5.0 (SDK 21) or later');
        continue;
      }
      const t0 = Date.now();
      // Same atomic, versioned install the agent uses: safe to run while the agent is live.
      const jarPath = await ensureDeviceJar(adb, d.id, cfg.scrcpyServerPath);
      ok(`scrcpy-server installed and verified on the device (${Date.now() - t0} ms): ${jarPath}`);

      // Start the JVM without sockets: proves the jar loads and lists the H.264 encoders.
      // From a throwaway copy: scrcpy-server deletes the file it was started from.
      const probe = await makeLaunchCopy(adb, d.id, jarPath)
        .then((copy) =>
          scrcpyStartupProbe(adb, d.id, copy).finally(() => removeLaunchCopy(adb, d.id, copy)),
        )
        .catch((e: Error) => `probe failed: ${e.message}`);
      const encoders = probe.split(/\r?\n/).filter((l) => /video-codec=h264/.test(l));
      if (/Aborted|ERROR|Exception|probe failed/i.test(probe) || !/encoder/i.test(probe)) {
        failures++;
        bad('scrcpy-server cannot start on this device:');
        for (const l of probe.trim().split(/\r?\n/).slice(-15)) info(l);
        const crash = await deviceCrashLog(adb, d.id);
        if (crash.length) {
          info('device log:');
          for (const l of crash) info(`  ${l}`);
        }
        continue;
      }
      ok(`scrcpy-server starts; ${encoders.length} H.264 encoder(s):`);
      for (const l of encoders) info(l.trim());

      let firstConfig: { w: number; h: number } | null = null;
      let frames = 0;
      const steps: string[] = [];
      const session = new ScrcpySession(
        adb,
        d.id,
        STREAM_QUALITY_PRESETS.MEDIUM,
        {
          sendFrame: (bytes) => {
            const f = decodeFrame(bytes);
            if (f.type === FrameType.VIDEO_CONFIG) firstConfig ??= { w: f.width, h: f.height };
            if (f.type === FrameType.VIDEO_FRAME) frames++;
          },
          status: (state, message) => steps.push(`${state}${message ? `: ${message}` : ''}`),
        },
        pino({ level: process.env.LOG_LEVEL ?? 'warn' }),
        cfg.scrcpyCodecOptions,
        jarPath,
      );
      const t1 = Date.now();
      try {
        await session.start();
        ok(`scrcpy-server handshake (${Date.now() - t1} ms)`);
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline && frames === 0) await new Promise((r) => setTimeout(r, 100));
        const cfgFrame = firstConfig as { w: number; h: number } | null;
        if (frames > 0) {
          ok(
            `receiving H.264: ${cfgFrame ? `${cfgFrame.w}×${cfgFrame.h}` : 'size unknown'}, first frame after ${Date.now() - t1} ms`,
          );
        } else {
          failures++;
          bad(
            'handshake succeeded but no video frames arrived within 8 s (screen off? try unlocking the phone)',
          );
        }
      } catch (err) {
        failures++;
        bad(`stream start failed: ${(err as Error).message}`);
        for (const s of steps) info(s);
        const crash = await deviceCrashLog(adb, d.id);
        if (crash.length) {
          info('device log:');
          for (const l of crash) info(`  ${l}`);
        }
      } finally {
        await session.stop();
      }
    } catch (err) {
      failures++;
      bad((err as Error).message);
    }
  }

  process.stdout.write(
    failures ? `\n${failures} problem(s) found.\n\n` : '\nAll checks passed.\n\n',
  );
  return failures ? 1 : 0;
}
