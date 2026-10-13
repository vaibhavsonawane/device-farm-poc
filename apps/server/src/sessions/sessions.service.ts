import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  type CreateSessionRequest,
  Permission,
  STREAM_PORTAL_PATH,
  STREAM_QUALITY_PRESETS,
  type SessionDto,
  type SessionJoinDto,
  type StreamQuality,
  can,
} from '@devicelab/shared-types';
import { AuditAction, AuditService } from '../audit/audit.service';
import { type AuthUser } from '../common/auth.decorators';
import { toSessionDto } from '../common/mappers';
import { PrismaService } from '../prisma/prisma.service';
import { AgentRegistry, DomainEvents } from '../realtime/realtime.services';
import { ReservationsService } from '../reservations/reservations.service';
import { StreamRelayService } from './stream-relay.service';
import { StreamTokens } from './stream-tokens';

export interface SessionAccess {
  sessionId: string;
  role: 'controller' | 'observer';
  hostId: string;
  serial: string;
  deviceId: string;
  reservationId: string;
}

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: ReservationsService,
    private readonly relay: StreamRelayService,
    private readonly tokens: StreamTokens,
    private readonly agents: AgentRegistry,
    private readonly domain: DomainEvents,
    private readonly audit: AuditService,
  ) {}

  private async join(
    sessionId: string,
    userId: string,
    role: 'controller' | 'observer',
  ): Promise<SessionJoinDto> {
    const s = await this.prisma.session.findUniqueOrThrow({
      where: { id: sessionId },
      include: { reservation: { select: { deviceId: true } } },
    });
    return {
      session: toSessionDto(s),
      role,
      streamTicket: await this.tokens.viewerTicket(sessionId, userId, role),
      streamPath: STREAM_PORTAL_PATH,
    };
  }

  /** Start (or rejoin) the live session for a reservation you hold. */
  async start(
    user: AuthUser,
    body: CreateSessionRequest,
    ip: string | null,
  ): Promise<SessionJoinDto> {
    const r = await this.reservations.getOwnActive(user, body.reservationId);
    let session = await this.prisma.session.findFirst({
      where: { reservationId: r.id, endedAt: null },
    });
    if (!session) {
      session = await this.prisma.session.create({ data: { reservationId: r.id } });
      await this.audit.log({
        action: AuditAction.SESSION_START,
        userId: user.id,
        entityType: 'Session',
        entityId: session.id,
        metadata: { reservationId: r.id, deviceId: r.deviceId },
        ip,
      });
    }
    await this.relay
      .ensureStreaming(session.id, body.quality ?? STREAM_QUALITY_PRESETS.MEDIUM)
      .catch((err: Error) => {
        // Not fatal: the viewer socket retries, and the portal shows the stream status.
        this.logger.warn(`stream start for ${session.id} failed: ${err.message}`);
      });
    await this.reservations.touch(r.id, true);
    return this.join(session.id, user.id, 'controller');
  }

  /** Read-only ticket for leads/managers with device:observe. */
  async observe(user: AuthUser, sessionId: string, ip: string | null): Promise<SessionJoinDto> {
    const access = await this.access(user, sessionId);
    if (access.role === 'controller') return this.join(sessionId, user.id, 'controller');
    await this.audit.log({
      action: AuditAction.SESSION_OBSERVE,
      userId: user.id,
      entityType: 'Session',
      entityId: sessionId,
      ip,
    });
    return this.join(sessionId, user.id, 'observer');
  }

  async end(user: AuthUser, sessionId: string, ip: string | null): Promise<SessionDto> {
    const access = await this.access(user, sessionId);
    if (access.role !== 'controller') throw new ForbiddenException();
    const s = await this.prisma.session.update({
      where: { id: sessionId },
      data: { endedAt: new Date(), disconnectReason: 'user ended session' },
      include: { reservation: { select: { deviceId: true } } },
    });
    void this.agents.command(access.hostId, 'stream:stop', { sessionId }, 5000);
    this.domain.emit({ type: 'session.ended', sessionId });
    await this.audit.log({
      action: AuditAction.SESSION_END,
      userId: user.id,
      entityType: 'Session',
      entityId: sessionId,
      ip,
    });
    return toSessionDto(s);
  }

  async setQuality(user: AuthUser, sessionId: string, quality: StreamQuality): Promise<void> {
    const access = await this.access(user, sessionId);
    if (access.role !== 'controller')
      throw new ForbiddenException('Only the controller can change quality');
    const res = await this.relay.setQuality(sessionId, quality);
    if (!res.ok) throw new ConflictException(res.error);
  }

  /** Who may do what in a session: the reservation holder controls, observers watch. */
  async access(user: AuthUser, sessionId: string): Promise<SessionAccess> {
    const s = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        reservation: { include: { device: { select: { id: true, udid: true, hostId: true } } } },
      },
    });
    if (!s) throw new NotFoundException('Session not found');
    if (s.endedAt || s.reservation.status !== 'ACTIVE')
      throw new ConflictException('Session has ended');
    const base = {
      sessionId,
      hostId: s.reservation.device.hostId,
      serial: s.reservation.device.udid,
      deviceId: s.reservation.device.id,
      reservationId: s.reservationId,
    };
    if (s.reservation.userId === user.id && can(user.role, Permission.DEVICE_USE))
      return { ...base, role: 'controller' };
    if (can(user.role, Permission.DEVICE_OBSERVE)) return { ...base, role: 'observer' };
    throw new ForbiddenException('You cannot view this session');
  }

  async listActive(): Promise<(SessionDto & { userName: string; deviceModel: string })[]> {
    const rows = await this.prisma.session.findMany({
      where: { endedAt: null, reservation: { status: 'ACTIVE' } },
      include: {
        reservation: {
          select: {
            deviceId: true,
            user: { select: { name: true } },
            device: { select: { model: true } },
          },
        },
      },
      orderBy: { startedAt: 'desc' },
    });
    return rows.map((s) => ({
      ...toSessionDto(s),
      userName: s.reservation.user.name,
      deviceModel: s.reservation.device.model,
    }));
  }
}
