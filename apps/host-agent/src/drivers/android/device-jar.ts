import { SCRCPY_SERVER_VERSION } from '@devicelab/protocol';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { type AdbBridge, shq, withTimeout } from './adb';
import { remoteSha256 } from './diagnostics';
import { SCRCPY_SERVER_SHA256, checkScrcpyJar } from './scrcpy-jar';

/**
 * Where scrcpy-server lives on the device. The name carries the version and
 * checksum, so agents or `--doctor` runs pinned to different versions never
 * overwrite each other's file, and a file that is in use is never modified.
 */
export const DEVICE_JAR_PATH = `/data/local/tmp/devicelab-scrcpy-server-v${SCRCPY_SERVER_VERSION}-${SCRCPY_SERVER_SHA256.slice(0, 12)}.jar`;

async function remoteSize(adb: AdbBridge, serial: string, path: string): Promise<number | null> {
  const out = await adb
    .shell(
      serial,
      `stat -c %s ${shq(path)} 2>/dev/null || wc -c < ${shq(path)} 2>/dev/null`,
      10_000,
    )
    .catch(() => '');
  const n = Number.parseInt(out.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** True when `path` on the device is exactly the pinned scrcpy-server. */
async function isExpectedJar(
  adb: AdbBridge,
  serial: string,
  path: string,
  expectedSha: string,
  localSize: number,
): Promise<boolean> {
  const sha = await remoteSha256(adb, serial, path);
  if (sha !== null) return sha === expectedSha;
  // Very old devices without sha256sum: fall back to the exact size.
  return (await remoteSize(adb, serial, path)) === localSize;
}

/**
 * Make sure the device has the pinned scrcpy-server and return its path.
 * Pushes to a temporary name, verifies it, then renames it into place
 * atomically — a concurrent session never sees a missing or partial file
 * (which makes app_process abort with ClassNotFoundException).
 */
export async function ensureDeviceJar(
  adb: AdbBridge,
  serial: string,
  localPath: string,
  opts: {
    force?: boolean;
    onStatus?: (msg: string) => void;
    /** Checksum the local and remote file must have (default: the pinned release). */
    expectedSha256?: string;
    /** Remote path (default: DEVICE_JAR_PATH). */
    remotePath?: string;
  } = {},
): Promise<string> {
  const expected = opts.expectedSha256 ?? SCRCPY_SERVER_SHA256;
  const finalPath = opts.remotePath ?? DEVICE_JAR_PATH;
  const problem =
    expected === SCRCPY_SERVER_SHA256
      ? checkScrcpyJar(localPath)
      : sha256File(localPath) === expected
        ? null
        : `${localPath} does not match the expected checksum`;
  if (problem) throw new Error(problem);
  const localSize = statSync(localPath).size;
  if (!opts.force && (await isExpectedJar(adb, serial, finalPath, expected, localSize)))
    return finalPath;

  opts.onStatus?.('Pushing scrcpy-server to the device…');
  const tmp = `${finalPath}.tmp-${randomBytes(4).toString('hex')}`;
  try {
    await withTimeout(
      adb.push(serial, localPath, tmp),
      30_000,
      'pushing scrcpy-server to the device timed out',
    );
    if (!(await isExpectedJar(adb, serial, tmp, expected, localSize))) {
      throw new Error(
        'scrcpy-server arrived corrupted on the device (checksum mismatch); check the USB cable/hub',
      );
    }
    const out = await adb.shell(
      serial,
      `mv -f ${shq(tmp)} ${shq(finalPath)} && echo DEVICELAB_OK`,
      10_000,
    );
    if (!out.includes('DEVICELAB_OK'))
      throw new Error(`could not install scrcpy-server on the device: ${out.trim().slice(0, 200)}`);
  } finally {
    await adb.shell(serial, `rm -f ${shq(tmp)}`, 10_000).catch(() => undefined);
  }
  return finalPath;
}

/**
 * scrcpy-server deletes the file it was started from: its CleanUp process (and
 * list mode, e.g. `list_encoders`) call `unlinkSelf()`. So never start it from
 * the installed jar — start every run from a throwaway copy, and the installed
 * file survives for the next start, watchdog restart, quality change or probe.
 */
export async function makeLaunchCopy(
  adb: AdbBridge,
  serial: string,
  jarPath: string,
): Promise<string> {
  const copy = `/data/local/tmp/devicelab-scrcpy-run-${randomBytes(4).toString('hex')}.jar`;
  // `cat` exists on every Android version (toybox `cp` only from Android 6).
  const out = await adb.shell(
    serial,
    `cat ${shq(jarPath)} > ${shq(copy)} && echo DEVICELAB_OK`,
    10_000,
  );
  if (!out.includes('DEVICELAB_OK')) {
    await removeLaunchCopy(adb, serial, copy);
    throw new Error(
      `scrcpy-server is missing on the device (${out.trim().slice(0, 200) || jarPath})`,
    );
  }
  return copy;
}

/** Delete a launch copy (scrcpy usually deletes it itself; this catches crashed runs). */
export async function removeLaunchCopy(
  adb: AdbBridge,
  serial: string,
  copy: string,
): Promise<void> {
  await adb.shell(serial, `rm -f ${shq(copy)}`, 10_000).catch(() => undefined);
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
