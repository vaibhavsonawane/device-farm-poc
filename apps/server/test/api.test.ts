/**
 * End-to-end API test against a real Postgres + Redis: auth, RBAC, agent
 * registration, reservations, the binary stream relay (single-writer rule) and
 * release cleanup.
 */
import { type NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { FrameType, TouchAction, decodeFrame, encodeFrame } from '@devicelab/protocol';
import {
  AGENT_NAMESPACE,
  type AgentToServerEvents,
  type ServerToAgentEvents,
} from '@devicelab/shared-types';
import type { AddressInfo } from 'node:net';
import { type Socket as ClientSocket, io } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { ReservationsService } from '../src/reservations/reservations.service';

type AgentClient = ClientSocket<ServerToAgentEvents, AgentToServerEvents>;

const PASSWORD = 'Test@Password123';
let app: NestExpressApplication;
let base: string;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
let agent: AgentClient;
let agentToken: string;
let deviceId: string;
const agentStreams: WebSocket[] = [];
const received = { start: [] as string[], cleanup: [] as string[], input: [] as number[] };

const http = () => request(app.getHttpServer());
const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(
  fn: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  ms = 5000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await wait(50);
  }
}

async function login(
  email: string,
  password = PASSWORD,
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await http().post('/api/auth/login').send({ email, password }).expect(200);
  return res.body;
}

function openViewer(
  path: string,
  ticket: string,
): Promise<{ ws: WebSocket; frames: Uint8Array[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${base.replace('http', 'ws')}${path}?ticket=${encodeURIComponent(ticket)}`,
    );
    const frames: Uint8Array[] = [];
    ws.binaryType = 'nodebuffer';
    ws.on('message', (d) => frames.push(new Uint8Array(d as Buffer)));
    ws.once('open', () => resolve({ ws, frames }));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication<NestExpressApplication>({ logger: ['error'] });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  prisma = app.get(PrismaService);
  // Safety: only ever wipe a database whose name ends in _test.
  const [row] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
  const db = row?.db ?? '';
  if (!db.endsWith('_test'))
    throw new Error(`refusing to run destructive tests against database "${db}"`);
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AuditLog", "Artifact", "Build", "Session", "Reservation", "Device", "Host", "RefreshToken", "User", "Project", "Team" CASCADE',
  );
  await app.get(RedisService).client.flushdb();

  const hash = await hashPassword(PASSWORD);
  for (const [email, role] of [
    ['admin@test.local', 'ADMIN'],
    ['tester@test.local', 'TESTER'],
    ['tester2@test.local', 'TESTER'],
    ['lead@test.local', 'LEAD'],
    ['viewer@test.local', 'VIEWER'],
  ] as const) {
    await prisma.user.create({
      data: { email, name: email.split('@')[0]!, role, passwordHash: hash },
    });
    tokens[email.split('@')[0]!] = (await login(email)).accessToken;
  }
});

afterAll(async () => {
  agent?.disconnect();
  for (const s of agentStreams) s.close();
  await app?.close();
});

describe('auth & RBAC', () => {
  it('reports health', async () => {
    const res = await http().get('/api/health').expect(200);
    expect(res.body.checks).toMatchObject({ database: true, redis: true });
  });

  it('rejects bad credentials with a generic message and audits it', async () => {
    const res = await http()
      .post('/api/auth/login')
      .send({ email: 'tester@test.local', password: 'nope' })
      .expect(401);
    expect(res.body.message).toBe('Invalid email or password');
    await http()
      .post('/api/auth/login')
      .send({ email: 'ghost@test.local', password: 'nope' })
      .expect(401);
    expect(
      await prisma.auditLog.count({ where: { action: 'auth.login_failed' } }),
    ).toBeGreaterThanOrEqual(2);
  });

  it('requires a token and enforces roles', async () => {
    await http().get('/api/devices').expect(401);
    await http().get('/api/devices').set('Authorization', 'Bearer garbage').expect(401);
    await http().get('/api/users').set(auth('tester')).expect(403);
    await http().get('/api/users').set(auth('admin')).expect(200);
    await http().get('/api/auth/me').set(auth('viewer')).expect(200);
  });

  it('validates input with zod', async () => {
    const res = await http()
      .post('/api/hosts')
      .set(auth('admin'))
      .send({ name: 'bad name!' })
      .expect(400);
    expect(res.body.errors[0].path).toBe('name');
  });

  it('rotates refresh tokens and detects reuse', async () => {
    const first = await login('tester2@test.local');
    const second = await http()
      .post('/api/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(200);
    expect(second.body.refreshToken).not.toBe(first.refreshToken);
    // Replaying the rotated token revokes the family — including the new token.
    await http().post('/api/auth/refresh').send({ refreshToken: first.refreshToken }).expect(401);
    await http()
      .post('/api/auth/refresh')
      .send({ refreshToken: second.body.refreshToken })
      .expect(401);
    expect(
      await prisma.auditLog.count({ where: { action: 'auth.refresh_reuse_detected' } }),
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('host agent registration', () => {
  it('rejects unknown agent tokens', async () => {
    const bad: AgentClient = io(`${base}${AGENT_NAMESPACE}`, {
      auth: { token: 'dlh_not_a_real_token_000000000' },
      transports: ['websocket'],
      reconnection: false,
    });
    const err = await new Promise<Error>((resolve) => bad.on('connect_error', resolve));
    expect(err.message).toBe('unauthorized');
    bad.close();
  });

  it('registers a host and its devices', async () => {
    await http().post('/api/hosts').set(auth('tester')).send({ name: 'lab-host-1' }).expect(403);
    const res = await http()
      .post('/api/hosts')
      .set(auth('admin'))
      .send({ name: 'lab-host-1' })
      .expect(201);
    agentToken = res.body.agentToken;
    expect(agentToken).toMatch(/^dlh_/);

    agent = io(`${base}${AGENT_NAMESPACE}`, {
      auth: { token: agentToken },
      transports: ['websocket'],
    });
    agent.on('stream:start', (cmd, ack) => {
      received.start.push(cmd.sessionId);
      const ws = new WebSocket(`${base.replace('http', 'ws')}${cmd.streamPath}`);
      ws.on('message', (d) => received.input.push(decodeFrame(new Uint8Array(d as Buffer)).type));
      agentStreams.push(ws);
      ws.once('open', () => ack({ ok: true }));
    });
    agent.on('stream:stop', (_cmd, ack) => ack({ ok: true }));
    agent.on('device:cleanup', (cmd, ack) => {
      received.cleanup.push(cmd.serial);
      ack({ ok: true });
    });
    await new Promise<void>((resolve) => agent.on('connect', () => resolve()));
    const welcome = await agent.emitWithAck('agent:hello', {
      hostName: 'lab-host-1',
      agentVersion: '0.1.0',
      os: 'linux',
      capabilities: { android: true, ios: false, appium: false, mock: true },
    });
    expect(welcome.ok).toBe(true);
    agent.emit('device:upsert', {
      serial: 'EMU-0001',
      platform: 'ANDROID',
      state: 'online',
      model: 'Pixel 8',
      manufacturer: 'Google',
      osVersion: '14',
      screenW: 1080,
      screenH: 2400,
      batteryLevel: 87,
    });
    const device = await until(async () => {
      const list = await http().get('/api/devices').set(auth('tester')).expect(200);
      return list.body.find(
        (d: { udid: string; status: string }) => d.udid === 'EMU-0001' && d.status === 'AVAILABLE',
      );
    });
    deviceId = device.id;
    expect(device).toMatchObject({ model: 'Pixel 8', hostName: 'lab-host-1', batteryLevel: 87 });
  });
});

describe('reservations, sessions and the stream relay', () => {
  let reservationId: string;
  let sessionId: string;

  it('reserves exclusively', async () => {
    await http().post('/api/reservations').set(auth('viewer')).send({ deviceId }).expect(403);
    const res = await http()
      .post('/api/reservations')
      .set(auth('tester'))
      .send({ deviceId, durationMinutes: 30 })
      .expect(201);
    reservationId = res.body.id;
    const conflict = await http()
      .post('/api/reservations')
      .set(auth('tester2'))
      .send({ deviceId })
      .expect(409);
    expect(conflict.body.message).toMatch(/in use by tester/);
    const dev = await http().get(`/api/devices/${deviceId}`).set(auth('tester')).expect(200);
    expect(dev.body.status).toBe('IN_USE');
  });

  it('races: only one of many concurrent reservations wins', async () => {
    await http().post(`/api/reservations/${reservationId}/release`).set(auth('tester')).expect(201);
    await until(
      async () =>
        (await http().get(`/api/devices/${deviceId}`).set(auth('tester'))).body.status ===
        'AVAILABLE',
    );
    const attempts = await Promise.all(
      ['tester', 'tester2', 'lead', 'admin'].map((who) =>
        http().post('/api/reservations').set(auth(who)).send({ deviceId }),
      ),
    );
    expect(attempts.filter((r) => r.status === 201)).toHaveLength(1);
    expect(attempts.filter((r) => r.status === 409)).toHaveLength(3);
    const winner = attempts.find((r) => r.status === 201)!;
    await http().post(`/api/reservations/${winner.body.id}/release`).set(auth('admin')).expect(201);
    await until(
      async () =>
        (await http().get(`/api/devices/${deviceId}`).set(auth('tester'))).body.status ===
        'AVAILABLE',
    );
    const res = await http()
      .post('/api/reservations')
      .set(auth('tester'))
      .send({ deviceId })
      .expect(201);
    reservationId = res.body.id;
  });

  it('relays video to every viewer but input only from the controller', async () => {
    await http().post('/api/sessions').set(auth('tester2')).send({ reservationId }).expect(403);
    const join = await http()
      .post('/api/sessions')
      .set(auth('tester'))
      .send({ reservationId })
      .expect(201);
    sessionId = join.body.session.id;
    expect(join.body.role).toBe('controller');
    await until(() => received.start.includes(sessionId));

    const obs = await http()
      .post(`/api/sessions/${sessionId}/ticket`)
      .set(auth('lead'))
      .expect(201);
    expect(obs.body.role).toBe('observer');
    await http().post(`/api/sessions/${sessionId}/ticket`).set(auth('tester2')).expect(403);

    const controller = await openViewer(join.body.streamPath, join.body.streamTicket);
    const observer = await openViewer(obs.body.streamPath, obs.body.streamTicket);
    await expect(openViewer(join.body.streamPath, 'forged')).rejects.toThrow(/401/);

    const agentWs = await until(() => agentStreams.find((s) => s.readyState === WebSocket.OPEN));
    agentWs.send(
      encodeFrame({
        type: FrameType.VIDEO_FRAME,
        keyframe: true,
        pts: 1n,
        data: Uint8Array.of(0, 0, 1, 0x65),
      }),
    );
    await until(() => controller.frames.length > 0 && observer.frames.length > 0);
    expect(decodeFrame(observer.frames[0]!).type).toBe(FrameType.VIDEO_FRAME);

    received.input.length = 0;
    observer.ws.send(
      encodeFrame({ type: FrameType.TOUCH, action: TouchAction.DOWN, pointerId: 0, x: 1, y: 1 }),
    );
    controller.ws.send(encodeFrame({ type: FrameType.TEXT, text: 'hello' }));
    await until(() => received.input.includes(FrameType.TEXT));
    await wait(100);
    expect(received.input).not.toContain(FrameType.TOUCH);

    controller.ws.close();
    observer.ws.close();
  });

  it('releases on idle and runs device cleanup', async () => {
    const svc = app.get(ReservationsService);
    const decisions = await svc.sweep(Date.now() + svc.policy.idleReleaseMs + 1000);
    expect(decisions).toContainEqual({ id: reservationId, decision: 'RELEASE_IDLE' });
    await until(() => received.cleanup.includes('EMU-0001'));
    const r = await http()
      .get(`/api/reservations/${reservationId}`)
      .set(auth('tester'))
      .expect(200);
    expect(r.body).toMatchObject({ status: 'EXPIRED', releaseReason: 'IDLE' });
    const session = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.endedAt).not.toBeNull();
    await until(
      async () =>
        (await http().get(`/api/devices/${deviceId}`).set(auth('tester'))).body.status ===
        'AVAILABLE',
    );
  });

  it('audits the lifecycle', async () => {
    const actions = (await prisma.auditLog.findMany({ select: { action: true } })).map(
      (a) => a.action,
    );
    for (const a of [
      'auth.login',
      'host.create',
      'reservation.create',
      'reservation.release',
      'session.start',
      'session.observe',
    ]) {
      expect(actions).toContain(a);
    }
  });

  it('marks devices offline when the host disconnects', async () => {
    agent.disconnect();
    await until(
      async () =>
        (await http().get(`/api/devices/${deviceId}`).set(auth('tester'))).body.status ===
        'OFFLINE',
    );
    const hosts = await http().get('/api/hosts').set(auth('tester')).expect(200);
    expect(hosts.body[0]).toMatchObject({ name: 'lab-host-1', status: 'OFFLINE' });
  });
});
