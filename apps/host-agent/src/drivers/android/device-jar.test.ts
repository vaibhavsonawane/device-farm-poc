import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEVICE_JAR_PATH, ensureDeviceJar as ensure } from './device-jar';

// A stand-in "official" jar so the test never depends on the downloaded vendor file.
const dir = mkdtempSync(path.join(tmpdir(), 'devicelab-jar-'));
const LOCAL = path.join(dir, 'scrcpy-server');
writeFileSync(LOCAL, Buffer.from('PK\x03\x04 fake scrcpy-server payload '.repeat(200)));
const SHA = createHash('sha256').update(readFileSync(LOCAL)).digest('hex');

const ensureDeviceJar = (
  adb: Parameters<typeof ensure>[0],
  serial: string,
  local: string,
  opts: { force?: boolean } = {},
) => ensure(adb, serial, local, { ...opts, expectedSha256: SHA });

/** Minimal fake device: a filesystem plus the few shell commands ensureDeviceJar uses. */
function fakeDevice(opts: { corruptPush?: boolean } = {}) {
  const fs = new Map<string, Buffer>();
  const log: string[] = [];
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const adb = {
    push: async (_s: string, local: string, remote: string) => {
      log.push(`push ${remote}`);
      const data = readFileSync(local);
      fs.set(remote, opts.corruptPush ? data.subarray(0, 100) : data);
    },
    shell: async (_s: string, cmd: string) => {
      log.push(cmd);
      const paths = [...cmd.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
      if (cmd.startsWith('sha256sum')) {
        const f = fs.get(paths[0]!);
        return f ? `${sha(f)}  ${paths[0]}\n` : '';
      }
      if (cmd.startsWith('mv -f')) {
        const f = fs.get(paths[0]!);
        if (!f) return 'mv: no such file';
        fs.set(paths[1]!, f);
        fs.delete(paths[0]!);
        return 'DEVICELAB_OK\n';
      }
      if (cmd.startsWith('rm -f')) {
        fs.delete(paths[0]!);
        return '';
      }
      return '';
    },
  };
  return { fs, log, adb: adb as unknown as Parameters<typeof ensureDeviceJar>[0] };
}

describe('ensureDeviceJar', () => {
  it('uses a versioned, checksum-specific path', () => {
    expect(DEVICE_JAR_PATH).toMatch(
      /^\/data\/local\/tmp\/devicelab-scrcpy-server-v\d+\.\d+\.\d+-[0-9a-f]{12}\.jar$/,
    );
  });

  it('pushes to a temp file, verifies it and renames it into place', async () => {
    const d = fakeDevice();
    expect(await ensureDeviceJar(d.adb, 'S', LOCAL)).toBe(DEVICE_JAR_PATH);
    expect(d.fs.get(DEVICE_JAR_PATH)?.equals(readFileSync(LOCAL))).toBe(true);
    expect([...d.fs.keys()]).toEqual([DEVICE_JAR_PATH]); // no temp file left behind
    expect(d.log.some((c) => c.startsWith(`push ${DEVICE_JAR_PATH}.tmp-`))).toBe(true);
  });

  it('does nothing when the device already has the right file', async () => {
    const d = fakeDevice();
    d.fs.set(DEVICE_JAR_PATH, readFileSync(LOCAL));
    await ensureDeviceJar(d.adb, 'S', LOCAL);
    expect(d.log.filter((c) => c.startsWith('push'))).toEqual([]);
  });

  it('never deletes or truncates the in-use file, even when forced or concurrent', async () => {
    const d = fakeDevice();
    d.fs.set(DEVICE_JAR_PATH, readFileSync(LOCAL));
    await Promise.all([
      ensureDeviceJar(d.adb, 'S', LOCAL, { force: true }),
      ensureDeviceJar(d.adb, 'S', LOCAL, { force: true }),
      ensureDeviceJar(d.adb, 'S', LOCAL),
    ]);
    expect(d.log.some((c) => c.startsWith('rm') && c.includes(`'${DEVICE_JAR_PATH}'`))).toBe(false);
    expect(d.log.some((c) => c === `push ${DEVICE_JAR_PATH}`)).toBe(false);
    expect(d.fs.get(DEVICE_JAR_PATH)?.equals(readFileSync(LOCAL))).toBe(true);
  });

  it('rejects a corrupted push and keeps the previous good file', async () => {
    const d = fakeDevice({ corruptPush: true });
    const good = readFileSync(LOCAL);
    d.fs.set(DEVICE_JAR_PATH, good);
    await expect(ensureDeviceJar(d.adb, 'S', LOCAL, { force: true })).rejects.toThrow(/corrupted/);
    expect(d.fs.get(DEVICE_JAR_PATH)).toBe(good);
    expect([...d.fs.keys()]).toEqual([DEVICE_JAR_PATH]);
  });
});
