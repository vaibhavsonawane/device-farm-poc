import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  FrameType,
  INPUT_FRAME_TYPES,
  VIDEO_FLAG_KEYFRAME,
  encodeFrame,
  peekFrameType,
} from '@devicelab/protocol';
import {
  STREAM_AGENT_PATH,
  STREAM_PORTAL_PATH,
  type StreamQuality,
  STREAM_QUALITY_PRESETS,
} from '@devicelab/shared-types';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { type Subscription } from 'rxjs';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import { PrismaService } from '../prisma/prisma.service';
import { AgentRegistry, DomainEvents, PortalEvents } from '../realtime/realtime.services';
import { ReservationsService } from '../reservations/reservations.service';
import { StreamTokens } from './stream-tokens';

/** Above this many queued bytes a viewer is "slow": drop delta frames until the next keyframe. */
const VIEWER_HIGH_WATER = 2 * 1024 * 1024;
const MJPEG_HIGH_WATER = 512 * 1024;
const NO_VIEWER_STOP_MS = 30_000;
const KEYFRAME_REQUEST_MIN_INTERVAL_MS = 750;

interface Viewer {
  userId: string;
  role: 'controller' | 'observer';
  needsKeyframe: boolean;
}

interface Room {
  sessionId: string;
  hostId: string;
  serial: string;
  reservationId: string;
  quality: StreamQuality;
  agent: WebSocket | null;
  viewers: Map<WebSocket, Viewer>;
  config: Uint8Array | null;
  lastMjpeg: Uint8Array | null;
  pingRoutes: Map<number, WebSocket>;
  stopTimer: NodeJS.Timeout | null;
  lastKeyframeRequest: number;
  starting: Promise<void> | null;
}

const REQUEST_KEYFRAME = encodeFrame({ type: FrameType.REQUEST_KEYFRAME });

function reject(socket: Duplex, code: number, text: string): void {
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

/**
 * Binary relay between the agent stream socket and browser stream sockets.
 * No transcoding: frames are forwarded as-is. Enforces the single-writer rule.
 */
@Injectable()
export class StreamRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StreamRelayService.name);
  private readonly rooms = new Map<string, Room>();
  private readonly agentWss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024 * 1024,
    perMessageDeflate: false,
  });
  private readonly viewerWss = new WebSocketServer({
    noServer: true,
    maxPayload: 128 * 1024,
    perMessageDeflate: false,
  });
  private keepalive: NodeJS.Timeout | null = null;
  private sub: Subscription | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: StreamTokens,
    private readonly agents: AgentRegistry,
    private readonly reservations: ReservationsService,
    private readonly domain: DomainEvents,
    private readonly events: PortalEvents,
  ) {}

  onModuleInit(): void {
    this.sub = this.domain.events$.subscribe((e) => {
      if (e.type === 'session.ended') this.closeRoom(e.sessionId, 4000, 'session ended');
    });
    this.keepalive = setInterval(() => {
      for (const ws of [...this.agentWss.clients, ...this.viewerWss.clients]) {
        const alive = ws as WebSocket & { isAlive?: boolean };
        if (alive.isAlive === false) {
          ws.terminate();
          continue;
        }
        alive.isAlive = false;
        ws.ping();
      }
    }, 15_000);
    this.keepalive.unref();
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
    if (this.keepalive) clearInterval(this.keepalive);
    for (const id of [...this.rooms.keys()]) this.closeRoom(id, 1001, 'server shutting down');
    this.agentWss.close();
    this.viewerWss.close();
  }

  /** Hook into the HTTP server's upgrade event (called from main.ts). */
  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === STREAM_AGENT_PATH) void this.handleAgentUpgrade(req, socket, head, url);
      else if (url.pathname === STREAM_PORTAL_PATH)
        void this.handleViewerUpgrade(req, socket, head, url);
      // Anything else (e.g. /socket.io) is left to its own upgrade handler.
    });
  }

  hasAgent(sessionId: string): boolean {
    return this.rooms.get(sessionId)?.agent?.readyState === WebSocket.OPEN;
  }

  viewerCount(sessionId: string): number {
    return this.rooms.get(sessionId)?.viewers.size ?? 0;
  }

  /** Make sure the agent is streaming this session (idempotent, de-duplicated). */
  async ensureStreaming(sessionId: string, quality?: StreamQuality): Promise<void> {
    const room = await this.getOrCreateRoom(sessionId);
    if (!room) throw new Error('session not found or ended');
    if (quality) room.quality = quality;
    if (room.agent?.readyState === WebSocket.OPEN) return;
    if (room.starting) return room.starting;
    room.starting = (async () => {
      const token = await this.tokens.agentToken(sessionId, room.hostId);
      const res = await this.agents.command(
        room.hostId,
        'stream:start',
        {
          sessionId,
          serial: room.serial,
          quality: room.quality,
          streamPath: `${STREAM_AGENT_PATH}?token=${encodeURIComponent(token)}`,
        },
        // The agent bounds each start step itself (≈45 s worst case) and reports progress.
        60_000,
      );
      if (!res.ok) {
        this.events.streamStatus({ sessionId, state: 'error', message: res.error });
        throw new Error(res.error);
      }
    })().finally(() => {
      room.starting = null;
    });
    return room.starting;
  }

  async setQuality(
    sessionId: string,
    quality: StreamQuality,
  ): Promise<{ ok: boolean; error?: string }> {
    const room = this.rooms.get(sessionId);
    if (!room) return { ok: false, error: 'not streaming' };
    room.quality = quality;
    room.config = null;
    const res = await this.agents.command(
      room.hostId,
      'stream:quality',
      { sessionId, quality },
      20_000,
    );
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }

  private async getOrCreateRoom(sessionId: string): Promise<Room | null> {
    const existing = this.rooms.get(sessionId);
    if (existing) return existing;
    const s = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { reservation: { include: { device: { select: { udid: true, hostId: true } } } } },
    });
    if (!s || s.endedAt || s.reservation.status !== 'ACTIVE') return null;
    const raced = this.rooms.get(sessionId);
    if (raced) return raced;
    const room: Room = {
      sessionId,
      hostId: s.reservation.device.hostId,
      serial: s.reservation.device.udid,
      reservationId: s.reservationId,
      quality: STREAM_QUALITY_PRESETS.MEDIUM,
      agent: null,
      viewers: new Map(),
      config: null,
      lastMjpeg: null,
      pingRoutes: new Map(),
      stopTimer: null,
      lastKeyframeRequest: 0,
      starting: null,
    };
    this.rooms.set(sessionId, room);
    return room;
  }

  private markAlive(ws: WebSocket): void {
    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    ws.on('pong', () => {
      (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    });
  }

  // ---------------------------------------------------------------- agent side

  private async handleAgentUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
  ): Promise<void> {
    const token = await this.tokens.verifyAgentToken(url.searchParams.get('token'));
    if (!token) return reject(socket, 401, 'Unauthorized');
    const room = await this.getOrCreateRoom(token.sid);
    if (!room) return reject(socket, 410, 'Gone');
    if (room.hostId !== token.hid || !this.agents.isConnected(token.hid))
      return reject(socket, 403, 'Forbidden');

    this.agentWss.handleUpgrade(req, socket, head, (ws) => {
      this.markAlive(ws);
      if (room.agent && room.agent !== ws) room.agent.close(4009, 'replaced');
      room.agent = ws;
      room.config = null;
      this.logger.log(`agent stream connected for session ${room.sessionId}`);
      for (const v of room.viewers.values()) v.needsKeyframe = true;

      ws.on('message', (data, isBinary) => {
        if (isBinary) this.onAgentFrame(room, toBytes(data));
      });
      ws.on('close', () => {
        if (room.agent === ws) room.agent = null;
        this.logger.log(`agent stream closed for session ${room.sessionId}`);
      });
      ws.on('error', (err) => this.logger.warn(`agent stream error: ${err.message}`));
    });
  }

  private onAgentFrame(room: Room, frame: Uint8Array): void {
    const type = peekFrameType(frame);
    switch (type) {
      case FrameType.VIDEO_CONFIG:
        room.config = frame;
        for (const [ws, v] of room.viewers) {
          v.needsKeyframe = true;
          this.send(ws, frame);
        }
        return;
      case FrameType.VIDEO_FRAME: {
        const key = ((frame[2] ?? 0) & VIDEO_FLAG_KEYFRAME) !== 0;
        let wantKeyframe = false;
        for (const [ws, v] of room.viewers) {
          if (v.needsKeyframe && !key) {
            wantKeyframe = true;
            continue;
          }
          if (ws.bufferedAmount > VIEWER_HIGH_WATER) {
            v.needsKeyframe = true;
            wantKeyframe = true;
            continue;
          }
          v.needsKeyframe = false;
          this.send(ws, frame);
        }
        if (wantKeyframe) this.requestKeyframe(room);
        return;
      }
      case FrameType.MJPEG_FRAME:
        room.lastMjpeg = frame;
        for (const ws of room.viewers.keys())
          if (ws.bufferedAmount < MJPEG_HIGH_WATER) this.send(ws, frame);
        return;
      case FrameType.PONG: {
        const seq = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(4);
        const target = room.pingRoutes.get(seq);
        room.pingRoutes.delete(seq);
        if (target) this.send(target, frame);
        return;
      }
      default:
        return;
    }
  }

  private requestKeyframe(room: Room): void {
    const now = Date.now();
    if (now - room.lastKeyframeRequest < KEYFRAME_REQUEST_MIN_INTERVAL_MS) return;
    room.lastKeyframeRequest = now;
    if (room.agent?.readyState === WebSocket.OPEN) room.agent.send(REQUEST_KEYFRAME);
  }

  private send(ws: WebSocket, frame: Uint8Array): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(frame, { binary: true });
  }

  // ---------------------------------------------------------------- viewer side

  private async handleViewerUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
  ): Promise<void> {
    const ticket = await this.tokens.verifyViewerTicket(url.searchParams.get('ticket'));
    if (!ticket) return reject(socket, 401, 'Unauthorized');
    const room = await this.getOrCreateRoom(ticket.sid);
    if (!room) return reject(socket, 410, 'Gone');
    if (ticket.role === 'controller') {
      const r = await this.prisma.reservation.findUnique({
        where: { id: room.reservationId },
        select: { userId: true, status: true },
      });
      if (!r || r.status !== 'ACTIVE' || r.userId !== ticket.sub)
        return reject(socket, 403, 'Forbidden');
    }

    this.viewerWss.handleUpgrade(req, socket, head, (ws) => {
      this.markAlive(ws);
      // Only one controller socket: a newer tab takes over control, the old one is closed.
      if (ticket.role === 'controller') {
        for (const [other, v] of room.viewers)
          if (v.role === 'controller') other.close(4009, 'opened in another tab');
      }
      room.viewers.set(ws, { userId: ticket.sub, role: ticket.role, needsKeyframe: true });
      if (room.stopTimer) {
        clearTimeout(room.stopTimer);
        room.stopTimer = null;
      }
      if (room.config) this.send(ws, room.config);
      if (room.lastMjpeg) this.send(ws, room.lastMjpeg);
      if (room.agent) this.requestKeyframe(room);
      else
        void this.ensureStreaming(room.sessionId).catch((err: Error) =>
          this.logger.warn(`stream start failed: ${err.message}`),
        );
      if (ticket.role === 'controller') void this.reservations.touch(room.reservationId, true);

      ws.on('message', (data, isBinary) => {
        if (isBinary) this.onViewerFrame(room, ws, toBytes(data));
      });
      ws.on('close', () => this.onViewerClose(room, ws));
      ws.on('error', (err) => this.logger.debug(`viewer stream error: ${err.message}`));
    });
  }

  private onViewerFrame(room: Room, ws: WebSocket, frame: Uint8Array): void {
    const viewer = room.viewers.get(ws);
    const type = peekFrameType(frame);
    if (!viewer || type === null || room.agent?.readyState !== WebSocket.OPEN) return;
    if (type === FrameType.PING) {
      if (frame.byteLength < 16) return;
      const seq = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(4);
      if (room.pingRoutes.size > 256) room.pingRoutes.clear();
      room.pingRoutes.set(seq, ws);
      room.agent.send(frame);
      return;
    }
    if (!INPUT_FRAME_TYPES.has(type)) return;
    // Single-writer rule: observers can watch, never touch.
    if (viewer.role !== 'controller') return;
    room.agent.send(frame);
    void this.reservations.touch(room.reservationId);
  }

  private onViewerClose(room: Room, ws: WebSocket): void {
    room.viewers.delete(ws);
    for (const [seq, target] of room.pingRoutes) if (target === ws) room.pingRoutes.delete(seq);
    if (room.viewers.size > 0 || room.stopTimer) return;
    // Nobody watching: stop the encoder after a grace period (tab reloads reconnect within it).
    room.stopTimer = setTimeout(() => {
      room.stopTimer = null;
      if (room.viewers.size > 0) return;
      void this.agents.command(room.hostId, 'stream:stop', { sessionId: room.sessionId }, 5000);
      room.agent?.close(1000, 'no viewers');
      this.rooms.delete(room.sessionId);
    }, NO_VIEWER_STOP_MS);
    room.stopTimer.unref();
  }

  private closeRoom(sessionId: string, code: number, reason: string): void {
    const room = this.rooms.get(sessionId);
    if (!room) return;
    if (room.stopTimer) clearTimeout(room.stopTimer);
    for (const ws of room.viewers.keys()) ws.close(code, reason);
    room.agent?.close(code, reason);
    this.rooms.delete(sessionId);
  }
}
