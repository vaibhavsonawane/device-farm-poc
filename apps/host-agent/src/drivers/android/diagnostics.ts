import { SCRCPY_SERVER_VERSION } from '@devicelab/protocol';
import { type AdbBridge, shq } from './adb';

/** SHA-256 of a file on the device, or null if the device has no sha256sum (Android < 8). */
export async function remoteSha256(
  adb: AdbBridge,
  serial: string,
  path: string,
): Promise<string | null> {
  const out = await adb
    .shell(
      serial,
      `sha256sum ${shq(path)} 2>/dev/null || toybox sha256sum ${shq(path)} 2>/dev/null`,
      15_000,
    )
    .catch(() => '');
  const m = /^([0-9a-f]{64})\s/m.exec(out.trim());
  return m ? m[1]! : null;
}

const CRASH_PATTERN =
  /scrcpy|AndroidRuntime|FATAL|Abort|DEBUG\s*:|libc\s*:|art\s*:|dalvikvm|app_process/i;

/**
 * Recent device log lines that explain why app_process / scrcpy-server died
 * (an "Aborted" from the shell carries no reason by itself).
 */
export async function deviceCrashLog(
  adb: AdbBridge,
  serial: string,
  maxLines = 25,
): Promise<string[]> {
  const out = await adb.shell(serial, 'logcat -d -v brief -t 800', 15_000).catch(() => '');
  return out
    .split(/\r?\n/)
    .filter((l) => CRASH_PATTERN.test(l))
    .slice(-maxLines);
}

/**
 * Start scrcpy-server without sockets (`list_encoders=true` prints the device's
 * encoders and exits). Proves the jar loads and the JVM starts on this device.
 */
export async function scrcpyStartupProbe(
  adb: AdbBridge,
  serial: string,
  jarPath: string,
): Promise<string> {
  return adb.shell(
    serial,
    `CLASSPATH=${shq(jarPath)} app_process / com.genymobile.scrcpy.Server ${SCRCPY_SERVER_VERSION} list_encoders=true log_level=info 2>&1`,
    20_000,
  );
}
