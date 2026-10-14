import { FrameType, decodeFrame } from '@devicelab/protocol';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { type AdbBridge } from './adb';
import { DEVICE_JAR_PATH } from './device-jar';
import { ScrcpySession } from './scrcpy-session';

const SPS = Buffer.from('6764001facd940b40a1b011000000300100000030320f1831960', 'hex');

/**
 * Fake scrcpy-server with the real tunnel_forward ordering: accept video → dummy byte,
 * accept control, and only then send device meta, codec meta and a config packet.
 */
function fakeScrcpy(port: number): net.Server {
  const sockets: net.Socket[] = [];
  const server = net.createServer((s) => {
    sockets.push(s);
    if (sockets.length === 1) s.write(Buffer.from([0])); // dummy byte on the video socket
    if (sockets.length === 2) {
      const video = sockets[0]!;
      const name = Buffer.alloc(64);
      name.write('Pixel 8');
      const codec = Buffer.alloc(12);
      codec.writeUInt32BE(0x68323634, 0);
      codec.writeUInt32BE(720, 4);
      codec.writeUInt32BE(1280, 8);
      const config = Buffer.concat([Buffer.from([0, 0, 0, 1]), SPS]);
      const header = Buffer.alloc(12);
      header.writeBigUInt64BE(1n << 63n, 0);
      header.writeUInt32BE(config.length, 8);
      video.write(Buffer.concat([name, codec, header, config]));
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}

/**
 * Fake adb + device. Like the real scrcpy-server, a run deletes the file it was
 * started from (CleanUp.unlinkSelf) and aborts with ClassNotFoundException when
 * that file is missing.
 */
function fakeAdb(servers: net.Server[], files = new Set([DEVICE_JAR_PATH])) {
  let port = 0;
  const launchedFrom: string[] = [];
  const adb = {
    forward: async (_serial: string, local: string) => {
      port = Number(local.slice('tcp:'.length));
    },
    shell: async (_serial: string, cmd: string) => {
      const paths = [...cmd.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
      if (cmd.startsWith('cat ')) {
        if (!files.has(paths[0]!)) return `cat: ${paths[0]}: No such file or directory`;
        files.add(paths[1]!);
        return 'DEVICELAB_OK\n';
      }
      if (cmd.startsWith('rm -f')) files.delete(paths[0]!);
      return '';
    },
    shellStream: async (_serial: string, cmd: string) => {
      const jar = /^CLASSPATH=(\S+) /.exec(cmd)?.[1] ?? '';
      launchedFrom.push(jar);
      const out = new PassThrough();
      if (!files.has(jar)) {
        setImmediate(() => out.end('Aborted\n'));
      } else {
        files.delete(jar);
        servers.push(fakeScrcpy(port));
      }
      return out;
    },
    removeForward: async () => undefined,
  } as unknown as AdbBridge;
  return { adb, files, launchedFrom };
}

describe('ScrcpySession handshake', () => {
  const servers: net.Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  it('connects the control socket before reading metadata and forwards the config', async () => {
    const frames: Uint8Array[] = [];
    const statuses: string[] = [];
    const session = new ScrcpySession(
      fakeAdb(servers).adb,
      'SERIAL',
      { maxSize: 1280, bitRate: 4_000_000, maxFps: 30 },
      { sendFrame: (f) => frames.push(f), status: (s) => statuses.push(s) },
      pino({ level: 'silent' }),
    );
    await session.start();
    await expect.poll(() => frames.length, { timeout: 3000 }).toBeGreaterThan(0);
    const cfg = decodeFrame(frames[0]!);
    expect(cfg).toMatchObject({ type: FrameType.VIDEO_CONFIG, width: 720, height: 1280 });
    expect(statuses).toContain('streaming');
    await session.stop();
  }, 10_000);

  it('survives scrcpy-server deleting its own file: every run starts from a fresh copy', async () => {
    const dev = fakeAdb(servers);
    const frames: Uint8Array[] = [];
    const session = new ScrcpySession(
      dev.adb,
      'SERIAL',
      { maxSize: 1280, bitRate: 4_000_000, maxFps: 30 },
      { sendFrame: (f) => frames.push(f), status: () => undefined },
      pino({ level: 'silent' }),
    );
    await session.start();
    // A quality change restarts scrcpy-server; before the fix this hit ClassNotFoundException.
    await session.setQuality({ maxSize: 800, bitRate: 1_500_000, maxFps: 30 });
    await session.stop();
    expect(dev.launchedFrom).toHaveLength(2);
    expect(new Set(dev.launchedFrom).size).toBe(2);
    expect(dev.launchedFrom).not.toContain(DEVICE_JAR_PATH);
    // The installed jar is intact and no launch copies are left behind.
    expect([...dev.files]).toEqual([DEVICE_JAR_PATH]);
  }, 10_000);

  it('re-installs a missing jar before a restart when given an installer', async () => {
    const dev = fakeAdb(servers, new Set());
    let installs = 0;
    const session = new ScrcpySession(
      dev.adb,
      'SERIAL',
      { maxSize: 1280, bitRate: 4_000_000, maxFps: 30 },
      { sendFrame: () => undefined, status: () => undefined },
      pino({ level: 'silent' }),
      undefined,
      async () => {
        installs++;
        dev.files.add(DEVICE_JAR_PATH);
        return DEVICE_JAR_PATH;
      },
    );
    await session.start();
    dev.files.delete(DEVICE_JAR_PATH); // e.g. an old agent build deleted it
    await session.setQuality({ maxSize: 800, bitRate: 1_500_000, maxFps: 30 });
    await session.stop();
    expect(installs).toBe(2);
  }, 10_000);
});
