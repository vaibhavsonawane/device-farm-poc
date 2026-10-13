import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Reservation } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  type CreateReservationRequest,
  Permission,
  type ReleaseReason,
  type ReservationDto,
  can,
} from '@devicelab/shared-types';
import { AuditAction, AuditService } from '../audit/audit.service';
import { type AuthUser } from '../common/auth.decorators';
import { reservationInclude, toReservationDto } from '../common/mappers';
import { InjectEnv } from '../config/config.module';
import { type Env } from '../config/env';
import { DevicesService } from '../devices/devices.service';
import { PrismaService } from '../prisma/prisma.service';
import { AgentRegistry, DomainEvents, PortalEvents } from '../realtime/realtime.services';
import { RedisService } from '../redis/redis.service';
import {
  type ReservationPolicy,
  computeExtension,
  evaluateReservation,
  lockTtlMs,
  packagesToRemove,
  reservationLimitFor,
  resolveDurationMinutes,
} from './reservation-logic';

const lockKey = (deviceId: string): string => `lock:device:${deviceId}`;
const activityKey = (reservationId: string): string => `activity:${reservationId}`;
const warnedKey = (reservationId: string): string => `idlewarn:${reservationId}`;

const STATUS_FOR_REASON: Record<ReleaseReason, 'RELEASED' | 'EXPIRED'> = {
  USER: 'RELEASED',
  FORCED: 'RELEASED',
  IDLE: 'EXPIRED',
  EXPIRED: 'EXPIRED',
  DEVICE_OFFLINE: 'EXPIRED',
};

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);
  readonly policy: ReservationPolicy;
  private readonly lastActivityWrite = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly devices: DevicesService,
    private readonly agents: AgentRegistry,
    private readonly events: PortalEvents,
    private readonly domain: DomainEvents,
    private readonly audit: AuditService,
    @InjectEnv() private readonly env: Env,
  ) {
    this.policy = {
      defaultMinutes: env.RESERVATION_DEFAULT_MIN,
      maxMinutes: env.RESERVATION_MAX_MIN,
      idleWarnMs: env.IDLE_WARN_MIN * 60_000,
      idleReleaseMs: env.IDLE_RELEASE_MIN * 60_000,
      offlineGraceMs: env.DEVICE_OFFLINE_GRACE_MIN * 60_000,
    };
  }

  private async dto(id: string): Promise<ReservationDto> {
    const r = await this.prisma.reservation.findUniqueOrThrow({
      where: { id },
      include: reservationInclude,
    });
    return toReservationDto(r);
  }

  async create(
    user: AuthUser,
    body: CreateReservationRequest,
    ip: string | null,
  ): Promise<ReservationDto> {
    const device = await this.devices.getForUser(user, body.deviceId);
    if (device.status !== 'AVAILABLE') {
      throw new ConflictException(
        device.status === 'IN_USE'
          ? `Device is in use by ${device.reservations[0]?.user.name ?? 'someone else'}`
          : `Device is ${device.status.toLowerCase()}`,
      );
    }
    const limit = reservationLimitFor(user.role, {
      ADMIN: this.env.RESERVATION_LIMIT_ADMIN,
      LEAD: this.env.RESERVATION_LIMIT_LEAD,
      TESTER: this.env.RESERVATION_LIMIT_TESTER,
    });
    const mine = await this.prisma.reservation.count({
      where: { userId: user.id, status: 'ACTIVE' },
    });
    if (mine >= limit)
      throw new ConflictException(`You can hold at most ${limit} device(s) at once`);

    const minutes = resolveDurationMinutes(body.durationMinutes, this.policy);
    const now = new Date();
    const endAt = new Date(now.getTime() + minutes * 60_000);
    const id = randomUUID();

    // 1) Redis lock — fast, cross-request mutual exclusion.
    if (!(await this.redis.acquireLock(lockKey(device.id), id, lockTtlMs(endAt, now)))) {
      throw new ConflictException('Someone else just reserved this device');
    }
    // 2) DB row — the partial unique index is the final arbiter.
    try {
      await this.prisma.reservation.create({
        data: {
          id,
          deviceId: device.id,
          userId: user.id,
          purpose: body.purpose ?? null,
          startAt: now,
          endAt,
          status: 'ACTIVE',
        },
      });
    } catch (e) {
      await this.redis.releaseLock(lockKey(device.id), id);
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Device already reserved');
      }
      throw e;
    }
    await this.redis.client.set(
      activityKey(id),
      String(now.getTime()),
      'PX',
      lockTtlMs(endAt, now),
    );
    await this.devices.recompute(device.id);
    await this.audit.log({
      action: AuditAction.RESERVATION_CREATE,
      userId: user.id,
      entityType: 'Reservation',
      entityId: id,
      metadata: { deviceId: device.id, udid: device.udid, minutes, purpose: body.purpose },
      ip,
    });
    const dto = await this.dto(id);
    this.events.reservationUpdated(dto);
    return dto;
  }

  async extend(
    user: AuthUser,
    id: string,
    minutes: number,
    ip: string | null,
  ): Promise<ReservationDto> {
    const r = await this.getOwnActive(user, id);
    const res = computeExtension(r, minutes, new Date(), this.policy);
    if (!res.ok) throw new BadRequestException(res.reason);
    await this.prisma.reservation.update({ where: { id }, data: { endAt: res.endAt } });
    await this.redis.extendLock(lockKey(r.deviceId), id, lockTtlMs(res.endAt, new Date()));
    await this.touch(id, true);
    await this.devices.recompute(r.deviceId);
    await this.audit.log({
      action: AuditAction.RESERVATION_EXTEND,
      userId: user.id,
      entityType: 'Reservation',
      entityId: id,
      metadata: { minutes, endAt: res.endAt.toISOString() },
      ip,
    });
    const dto = await this.dto(id);
    this.events.reservationUpdated(dto);
    return dto;
  }

  async releaseByUser(user: AuthUser, id: string, ip: string | null): Promise<ReservationDto> {
    const r = await this.prisma.reservation.findUnique({ where: { id } });
    if (!r) throw new NotFoundException();
    const own = r.userId === user.id;
    if (!own && !can(user.role, Permission.RESERVATION_FORCE_RELEASE))
      throw new ForbiddenException();
    if (r.status !== 'ACTIVE') return this.dto(id);
    await this.release(id, own ? 'USER' : 'FORCED', user.id, ip);
    return this.dto(id);
  }

  /**
   * End a reservation: DB status, lock, sessions, then device cleanup in the background.
   * Idempotent — a reservation that is no longer ACTIVE is left untouched.
   */
  async release(
    id: string,
    reason: ReleaseReason,
    actorId: string | null,
    ip: string | null = null,
  ): Promise<boolean> {
    const now = new Date();
    const res = await this.prisma.reservation.updateMany({
      where: { id, status: 'ACTIVE' },
      data: {
        status: STATUS_FOR_REASON[reason],
        releasedAt: now,
        releaseReason: reason,
        releasedById: actorId,
      },
    });
    if (res.count === 0) return false;
    const r = await this.prisma.reservation.findUniqueOrThrow({
      where: { id },
      include: { device: { select: { id: true, udid: true, hostId: true, online: true } } },
    });

    await this.redis.releaseLock(lockKey(r.deviceId), id);
    await this.redis.client.del(activityKey(id), warnedKey(id));
    this.lastActivityWrite.delete(id);

    const sessions = await this.prisma.session.findMany({
      where: { reservationId: id, endedAt: null },
      select: { id: true },
    });
    if (sessions.length) {
      await this.prisma.session.updateMany({
        where: { reservationId: id, endedAt: null },
        data: { endedAt: now, disconnectReason: `reservation ${reason.toLowerCase()}` },
      });
    }
    for (const s of sessions) {
      void this.agents.command(r.device.hostId, 'stream:stop', { sessionId: s.id }, 5000);
      this.domain.emit({ type: 'session.ended', sessionId: s.id });
    }
    this.domain.emit({
      type: 'reservation.released',
      reservationId: id,
      deviceId: r.deviceId,
      reason,
    });

    await this.audit.log({
      action:
        reason === 'FORCED'
          ? AuditAction.RESERVATION_FORCE_RELEASE
          : AuditAction.RESERVATION_RELEASE,
      userId: actorId,
      entityType: 'Reservation',
      entityId: id,
      metadata: {
        reason,
        deviceId: r.deviceId,
        ownerId: r.userId,
        sessions: sessions.map((s) => s.id),
      },
      ip,
    });
    this.events.released(r.userId, id, reason);
    this.events.reservationUpdated(await this.dto(id));

    void this.cleanup(r, sessions[0]?.id ?? null);
    return true;
  }

  /** Post-session cleanup on the device. The device reads IN_USE until it finishes. */
  private async cleanup(
    r: Reservation & { device: { id: string; udid: string; hostId: string; online: boolean } },
    sessionId: string | null,
  ): Promise<void> {
    if (!r.device.online || !this.agents.isConnected(r.device.hostId)) {
      await this.devices.recompute(r.device.id);
      return;
    }
    await this.devices.setCleaning(r.device.id, true);
    try {
      const result = await this.agents.command(
        r.device.hostId,
        'device:cleanup',
        {
          serial: r.device.udid,
          sessionId,
          uninstallPackages: packagesToRemove(r.installedPackages, this.env.CLEANUP_KEEP_PACKAGES),
          reboot: this.env.CLEANUP_REBOOT,
        },
        120_000,
      );
      if (!result.ok) this.logger.warn(`cleanup of ${r.device.udid} failed: ${result.error}`);
    } finally {
      await this.devices.setCleaning(r.device.id, false);
    }
  }

  async listForUser(user: AuthUser, scope: 'mine' | 'active-all'): Promise<ReservationDto[]> {
    if (scope === 'active-all' && !can(user.role, Permission.RESERVATION_READ_ALL))
      throw new ForbiddenException();
    const rows = await this.prisma.reservation.findMany({
      where:
        scope === 'mine'
          ? {
              userId: user.id,
              OR: [
                { status: 'ACTIVE' },
                { releasedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
              ],
            }
          : { status: 'ACTIVE' },
      include: reservationInclude,
      orderBy: { startAt: 'desc' },
      take: 100,
    });
    return rows.map(toReservationDto);
  }

  async get(user: AuthUser, id: string): Promise<ReservationDto> {
    const r = await this.prisma.reservation.findUnique({ where: { id } });
    if (!r) throw new NotFoundException();
    if (r.userId !== user.id && !can(user.role, Permission.RESERVATION_READ_ALL))
      throw new ForbiddenException();
    return this.dto(id);
  }

  async getOwnActive(user: Pick<AuthUser, 'id'>, id: string): Promise<Reservation> {
    const r = await this.prisma.reservation.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Reservation not found');
    if (r.userId !== user.id) throw new ForbiddenException('Not your reservation');
    if (r.status !== 'ACTIVE') throw new ConflictException('Reservation is no longer active');
    return r;
  }

  /** The caller must currently hold the device (used by install / apps / screenshot). */
  async assertHolder(user: Pick<AuthUser, 'id'>, deviceId: string): Promise<Reservation> {
    const r = await this.prisma.reservation.findFirst({ where: { deviceId, status: 'ACTIVE' } });
    if (!r || r.userId !== user.id) throw new ForbiddenException('Reserve this device first');
    return r;
  }

  async addInstalledPackages(id: string, packages: string[]): Promise<void> {
    if (!packages.length) return;
    const r = await this.prisma.reservation.findUnique({
      where: { id },
      select: { installedPackages: true },
    });
    if (!r) return;
    const merged = [...new Set([...r.installedPackages, ...packages])];
    await this.prisma.reservation.update({ where: { id }, data: { installedPackages: merged } });
  }

  /** Record user activity (throttled to one Redis write per second per reservation). */
  async touch(id: string, force = false): Promise<void> {
    const now = Date.now();
    const last = this.lastActivityWrite.get(id) ?? 0;
    if (!force && now - last < 1000) return;
    this.lastActivityWrite.set(id, now);
    await this.redis.client.set(
      activityKey(id),
      String(now),
      'PX',
      this.policy.maxMinutes * 60_000 + 600_000,
    );
  }

  /** One sweeper pass. Returns the decisions taken (useful for tests and logs). */
  async sweep(now = Date.now()): Promise<{ id: string; decision: string }[]> {
    const active = await this.prisma.reservation.findMany({
      where: { status: 'ACTIVE' },
      include: { device: { select: { online: true, offlineSince: true } } },
    });
    if (!active.length) return [];
    const keys = active.flatMap((r) => [activityKey(r.id), warnedKey(r.id)]);
    const values = await this.redis.client.mget(keys);
    const out: { id: string; decision: string }[] = [];
    for (const [i, r] of active.entries()) {
      const activity = Number(values[i * 2] ?? r.startAt.getTime());
      const warned = values[i * 2 + 1];
      const decision = evaluateReservation(
        {
          now,
          endAt: r.endAt.getTime(),
          reservationKind: r.kind,
          lastActivityAt: Number.isFinite(activity) ? activity : r.startAt.getTime(),
          warnedForActivityAt: warned ? Number(warned) : null,
          deviceOnline: r.device.online,
          deviceOfflineSince: r.device.offlineSince?.getTime() ?? null,
        },
        this.policy,
      );
      if (decision.kind === 'WARN_IDLE') {
        await this.redis.client.set(
          warnedKey(r.id),
          String(activity),
          'PX',
          this.policy.idleReleaseMs * 2,
        );
        this.events.idleWarning(r.userId, r.id, decision.releaseInSec);
      } else if (decision.kind === 'RELEASE') {
        this.logger.log(`releasing reservation ${r.id}: ${decision.reason}`);
        await this.release(r.id, decision.reason, null);
      }
      if (decision.kind !== 'NONE')
        out.push({
          id: r.id,
          decision: decision.kind === 'RELEASE' ? `RELEASE_${decision.reason}` : decision.kind,
        });
    }
    return out;
  }
}
