import { Injectable, Logger } from '@nestjs/common';
import { type Prisma } from '@prisma/client';
import { type AuditLogDto } from '@devicelab/shared-types';
import { PrismaService } from '../prisma/prisma.service';

/** Canonical audit action names. Add new ones here rather than inline strings. */
export const AuditAction = {
  LOGIN: 'auth.login',
  LOGIN_FAILED: 'auth.login_failed',
  LOGOUT: 'auth.logout',
  REFRESH_REUSE: 'auth.refresh_reuse_detected',
  USER_CREATE: 'user.create',
  USER_UPDATE: 'user.update',
  ORG_CHANGE: 'org.change',
  HOST_CREATE: 'host.create',
  HOST_REVOKE: 'host.revoke',
  HOST_ROTATE_TOKEN: 'host.rotate_token',
  HOST_DELETE: 'host.delete',
  HOST_RESYNC: 'host.resync',
  HOST_REJECTED: 'host.rejected',
  DEVICE_UPDATE: 'device.update',
  DEVICE_REBOOT: 'device.reboot',
  DEVICE_REMOVE: 'device.remove',
  RESERVATION_CREATE: 'reservation.create',
  RESERVATION_EXTEND: 'reservation.extend',
  RESERVATION_RELEASE: 'reservation.release',
  RESERVATION_FORCE_RELEASE: 'reservation.force_release',
  SESSION_START: 'session.start',
  SESSION_OBSERVE: 'session.observe',
  SESSION_END: 'session.end',
  BUILD_UPLOAD: 'build.upload',
  BUILD_DOWNLOAD: 'build.download',
  APP_INSTALL: 'app.install',
  APP_UNINSTALL: 'app.uninstall',
  APP_ACTION: 'app.action',
  ARTIFACT_CREATE: 'artifact.create',
  ARTIFACT_DOWNLOAD: 'artifact.download',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntry {
  action: AuditAction;
  userId?: string | null;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Never throws: an audit failure is logged loudly but must not break the user action. */
  async log(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: entry.action,
          userId: entry.userId ?? null,
          entityType: entry.entityType ?? null,
          entityId: entry.entityId ?? null,
          metadata: (entry.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
          ip: entry.ip ?? null,
        },
      });
    } catch (err) {
      this.logger.error(`AUDIT WRITE FAILED for ${entry.action}: ${(err as Error).message}`);
    }
  }

  async list(filter: {
    userId?: string;
    action?: string;
    entityType?: string;
    entityId?: string;
    from?: Date;
    to?: Date;
    page: number;
    pageSize: number;
  }): Promise<{ items: AuditLogDto[]; total: number }> {
    const where: Prisma.AuditLogWhereInput = {
      userId: filter.userId,
      action: filter.action ? { startsWith: filter.action } : undefined,
      entityType: filter.entityType,
      entityId: filter.entityId,
      createdAt: filter.from || filter.to ? { gte: filter.from, lte: filter.to } : undefined,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
        include: { user: { select: { name: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        userName: r.user?.name ?? null,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        metadata: (r.metadata as Record<string, unknown> | null) ?? null,
        ip: r.ip,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }
}
