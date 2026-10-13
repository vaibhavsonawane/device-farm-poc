import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { type OnGatewayConnection, type OnGatewayInit, WebSocketGateway } from '@nestjs/websockets';
import {
  PORTAL_NAMESPACE,
  Permission,
  type PortalAck,
  type PortalToServerEvents,
  type ServerToPortalEvents,
  can,
  sessionLogsControlSchema,
  sessionRefSchema,
  streamQualityUpdateSchema,
} from '@devicelab/shared-types';
import { type Namespace, type Socket } from 'socket.io';
import { type AuthUser } from '../common/auth.decorators';
import { UserResolver, verifyAccessToken } from '../common/guards';
import { safeParse } from '../common/zod';
import { SessionsService } from '../sessions/sessions.service';
import { AgentRegistry, PortalEvents, Rooms } from './realtime.services';

type PortalSocket = Socket<
  PortalToServerEvents,
  ServerToPortalEvents,
  Record<string, never>,
  { user: AuthUser }
>;

function fail(ack: PortalAck | undefined, error: string): void {
  if (typeof ack === 'function') ack({ ok: false, error });
}

/** JSON control channel for browsers. Every event re-checks permissions. */
@WebSocketGateway({ namespace: PORTAL_NAMESPACE })
export class PortalGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(PortalGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly users: UserResolver,
    private readonly events: PortalEvents,
    private readonly sessions: SessionsService,
    private readonly agents: AgentRegistry,
  ) {}

  afterInit(nsp: Namespace<PortalToServerEvents, ServerToPortalEvents>): void {
    this.events.attach(nsp as unknown as Parameters<PortalEvents['attach']>[0]);
    nsp.use((socket, next) => {
      const auth = socket.handshake.auth as { token?: unknown } | undefined;
      const token = typeof auth?.token === 'string' ? auth.token : null;
      void verifyAccessToken(this.jwt, this.users, token).then((user) => {
        if (!user) return next(new Error('unauthorized'));
        (socket.data as { user: AuthUser }).user = user;
        next();
      });
    });
  }

  handleConnection(socket: PortalSocket): void {
    const user = socket.data.user;
    void socket.join(Rooms.user(user.id));
    if (can(user.role, Permission.DEVICE_READ)) void socket.join(Rooms.inventory);
    if (can(user.role, Permission.RESERVATION_READ_ALL)) void socket.join(Rooms.reservationsAll);

    socket.on('session:subscribe', (raw, ack) => {
      const p = safeParse(sessionRefSchema, raw);
      if (!p) return fail(ack, 'invalid payload');
      this.sessions
        .access(user, p.sessionId)
        .then(async () => {
          await socket.join(Rooms.session(p.sessionId));
          ack({ ok: true });
        })
        .catch((err: Error) => fail(ack, err.message));
    });

    socket.on('session:unsubscribe', (raw, ack) => {
      const p = safeParse(sessionRefSchema, raw);
      if (!p) return fail(ack, 'invalid payload');
      void socket.leave(Rooms.session(p.sessionId));
      ack({ ok: true });
    });

    socket.on('session:logs', (raw, ack) => {
      const p = safeParse(sessionLogsControlSchema, raw);
      if (!p) return fail(ack, 'invalid payload');
      this.sessions
        .access(user, p.sessionId)
        .then(async (a) => {
          await socket.join(Rooms.session(p.sessionId));
          const res = await this.agents.command(a.hostId, 'device:logs', {
            serial: a.serial,
            sessionId: p.sessionId,
            action: p.action,
          });
          ack(res.ok ? { ok: true } : { ok: false, error: res.error });
        })
        .catch((err: Error) => fail(ack, err.message));
    });

    socket.on('session:quality', (raw, ack) => {
      const p = safeParse(streamQualityUpdateSchema, raw);
      if (!p) return fail(ack, 'invalid payload');
      this.sessions
        .setQuality(user, p.sessionId, p.quality)
        .then(() => ack({ ok: true }))
        .catch((err: Error) => fail(ack, err.message));
    });

    this.logger.debug(`portal socket connected: ${user.email}`);
  }
}
