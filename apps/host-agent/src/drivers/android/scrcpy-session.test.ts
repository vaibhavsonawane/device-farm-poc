import { FrameType, decodeFrame } from '@devicelab/protocol';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { type AdbBridge } from './adb';
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

function fakeAdb(servers: net.Server[]): AdbBridge {
  return {
    forward: async (_serial: string, local: string) => {
      servers.push(fakeScrcpy(Number(local.slice('tcp:'.length))));
    },
    shellStream: async () => new PassThrough(),
    removeForward: async () => undefined,
  } as unknown as AdbBridge;
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
      fakeAdb(servers),
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
});
