import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { type DeviceStatus, Prisma } from '@prisma/client';
import {
  type DeviceDto,
  type DeviceHealth,
  type DeviceReport,
  type UpdateDeviceRequest,
} from '@devicelab/shared-types';
import { type AuthUser } from '../common/auth.decorators';
import { canAccessProject, projectScopeWhere } from '../common/access';
import { type DeviceWithRelations, deviceInclude, toDeviceDto } from '../common/mappers';
import { PrismaService } from '../prisma/prisma.service';
import { PortalEvents } from '../realtime/realtime.services';

/** Pure status derivation — the single place that decides what a device "is". */
export function deriveDeviceStatus(d: {
  online: boolean;
  maintenance: boolean;
  cleaning: boolean;
  hasActiveReservation: boolean;
}): DeviceStatus {
  if (d.maintenance) return 'MAINTENANCE';
  if (!d.online) return 'OFFLINE';
  if (d.hasActiveReservation || d.cleaning) return 'IN_USE';
  return 'AVAILABLE';
}

const UNAUTHORIZED_HINT =
  'USB debugging not authorised — unlock the phone and accept the RSA fingerprint prompt.';
const OFFLINE_HINT = 'Device is connected but not responding (adb offline).';
const STATE_HINTS = new Set([UNAUTHORIZED_HINT, OFFLINE_HINT]);

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: PortalEvents,
  ) {}

  private async load(id: string): Promise<DeviceWithRelations | null> {
    return this.prisma.device.findUnique({ where: { id }, include: deviceInclude });
  }

  /** Recompute and persist the derived status, then broadcast the device. */
  async recompute(id: string): Promise<DeviceDto | null> {
    const d = await this.load(id);
    if (!d) return null;
    const status = deriveDeviceStatus({
      online: d.online,
      maintenance: d.maintenance,
      cleaning: d.cleaning,
      hasActiveReservation: d.reservations.length > 0,
    });
    const updated =
      status === d.status
        ? d
        : await this.prisma.device.update({
            where: { id },
            data: { status },
            include: deviceInclude,
          });
    const dto = toDeviceDto(updated);
    if (updated.removedAt) this.events.deviceRemoved(id);
    else this.events.deviceUpdated(dto);
    return dto;
  }

  async recomputeAll(): Promise<void> {
    const ids = await this.prisma.device.findMany({
      where: { removedAt: null },
      select: { id: true },
    });
    for (const { id } of ids) await this.recompute(id);
  }

  async upsertFromReport(hostId: string, r: DeviceReport): Promise<void> {
    const online = r.state === 'online';
    const now = new Date();
    const health: DeviceDto['health'] =
      r.state === 'unauthorized'
        ? { level: 'warn', message: UNAUTHORIZED_HINT, at: now.toISOString() }
        : r.state === 'offline'
          ? { level: 'warn', message: OFFLINE_HINT, at: now.toISOString() }
          : null;
    const details: Prisma.InputJsonValue = {
      temperatureC: r.temperatureC ?? null,
      network: r.network ?? null,
      storageFreeMb: r.storageFreeMb ?? null,
      storageTotalMb: r.storageTotalMb ?? null,
    };
    // Unauthorised devices report no properties; keep what we already know.
    const known = r.state === 'online' || r.model.length > 0;
    const existing = await this.prisma.device.findUnique({
      where: { udid: r.serial },
      select: { id: true, online: true, health: true },
    });
    const device = await this.prisma.device.upsert({
      where: { udid: r.serial },
      create: {
        udid: r.serial,
        platform: r.platform,
        model: r.model || 'Unknown',
        manufacturer: r.manufacturer || 'Unknown',
        osVersion: r.osVersion || '?',
        screenW: r.screenW,
        screenH: r.screenH,
        hostId,
        online,
        batteryLevel: r.batteryLevel,
        details,
        health: health ?? undefined,
        lastSeenAt: now,
        offlineSince: online ? null : now,
      },
      update: {
        platform: r.platform,
        hostId,
        online,
        removedAt: null,
        lastSeenAt: now,
        offlineSince: online ? null : existing?.online ? now : undefined,
        // Clear a previous state hint once the device is healthy again; keep other health messages.
        health:
          health ??
          (STATE_HINTS.has((existing?.health as { message?: string } | null)?.message ?? '')
            ? Prisma.DbNull
            : undefined),
        ...(known
          ? {
              model: r.model || undefined,
              manufacturer: r.manufacturer || undefined,
              osVersion: r.osVersion || undefined,
              screenW: r.screenW || undefined,
              screenH: r.screenH || undefined,
              batteryLevel: r.batteryLevel,
              details,
            }
          : {}),
      },
      select: { id: true },
    });
    await this.recompute(device.id);
  }

  async markDisconnected(hostId: string, serial: string): Promise<void> {
    const d = await this.prisma.device.findUnique({
      where: { udid: serial },
      select: { id: true, hostId: true, online: true },
    });
    if (!d || d.hostId !== hostId) return;
    if (d.online)
      await this.prisma.device.update({
        where: { id: d.id },
        data: { online: false, offlineSince: new Date() },
      });
    await this.recompute(d.id);
  }

  async setHealth(hostId: string, h: DeviceHealth): Promise<void> {
    const d = await this.prisma.device.findUnique({
      where: { udid: h.serial },
      select: { id: true, hostId: true },
    });
    if (!d || d.hostId !== hostId) return;
    await this.prisma.device.update({
      where: { id: d.id },
      data: { health: { level: h.level, message: h.message, at: new Date().toISOString() } },
    });
    await this.recompute(d.id);
  }

  async setCleaning(id: string, cleaning: boolean): Promise<void> {
    await this.prisma.device.update({ where: { id }, data: { cleaning } });
    await this.recompute(id);
  }

  async list(
    user: AuthUser,
    q: { platform?: string; status?: string; projectId?: string; q?: string },
  ): Promise<DeviceDto[]> {
    const text = q.q?.trim();
    const where: Prisma.DeviceWhereInput = {
      AND: [
        { removedAt: null },
        projectScopeWhere(user),
        q.platform ? { platform: q.platform as 'ANDROID' | 'IOS' } : {},
        q.status ? { status: q.status as DeviceStatus } : {},
        q.projectId ? { projectId: q.projectId } : {},
        text
          ? {
              OR: [
                { model: { contains: text, mode: 'insensitive' } },
                { manufacturer: { contains: text, mode: 'insensitive' } },
                { name: { contains: text, mode: 'insensitive' } },
                { udid: { contains: text, mode: 'insensitive' } },
                { osVersion: { startsWith: text } },
                { tags: { has: text } },
              ],
            }
          : {},
      ],
    };
    const rows = await this.prisma.device.findMany({
      where,
      include: deviceInclude,
      orderBy: [{ platform: 'asc' }, { model: 'asc' }],
    });
    return rows.map(toDeviceDto);
  }

  /** Load a device the user may see, or throw 404/403. */
  async getForUser(
    user: AuthUser,
    id: string,
  ): Promise<DeviceWithRelations & { project: { name: string; teamId: string | null } | null }> {
    const d = await this.prisma.device.findUnique({
      where: { id },
      include: { ...deviceInclude, project: { select: { name: true, teamId: true } } },
    });
    if (!d || d.removedAt) throw new NotFoundException('Device not found');
    if (!canAccessProject(user, d.project))
      throw new ForbiddenException('Device belongs to another team’s project');
    return d;
  }

  async update(id: string, body: UpdateDeviceRequest): Promise<DeviceDto> {
    const d = await this.prisma.device.findUnique({ where: { id } });
    if (!d || d.removedAt) throw new NotFoundException();
    await this.prisma.device.update({
      where: { id },
      data: {
        name: body.name,
        tags: body.tags ? [...new Set(body.tags)] : undefined,
        projectId: body.projectId,
        maintenance: body.maintenance,
        simNumber: body.simNumber,
        notes: body.notes,
      },
    });
    const dto = await this.recompute(id);
    if (!dto) throw new NotFoundException();
    return dto;
  }

  async remove(id: string): Promise<void> {
    const d = await this.load(id);
    if (!d) throw new NotFoundException();
    if (d.reservations.length > 0)
      throw new ConflictException('Release the active reservation first');
    await this.prisma.device.update({
      where: { id },
      data: { removedAt: new Date(), online: false },
    });
    this.events.deviceRemoved(id);
  }
}
