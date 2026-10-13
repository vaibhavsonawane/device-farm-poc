import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { type AgentHello, type HostDto, type HostTokenDto } from '@devicelab/shared-types';
import { AuditAction, AuditService } from '../audit/audit.service';
import { newAgentToken, sha256Hex } from '../common/crypto';
import { toHostDto } from '../common/mappers';
import { InjectEnv } from '../config/config.module';
import { type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { AgentRegistry, PortalEvents } from '../realtime/realtime.services';
import { DevicesService } from '../devices/devices.service';

@Injectable()
export class HostsService implements OnModuleInit {
  private readonly logger = new Logger(HostsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: PortalEvents,
    private readonly agents: AgentRegistry,
    private readonly devices: DevicesService,
    @InjectEnv() private readonly env: Env,
  ) {}

  async onModuleInit(): Promise<void> {
    // After a server restart no agent is connected yet; they will re-register.
    await this.prisma.host.updateMany({ where: { status: 'ONLINE' }, data: { status: 'OFFLINE' } });
    await this.prisma.device.updateMany({
      where: { online: true },
      data: { online: false, offlineSince: new Date() },
    });
    await this.devices.recomputeAll();
  }

  private async dto(id: string): Promise<HostDto> {
    const h = await this.prisma.host.findUniqueOrThrow({
      where: { id },
      include: { _count: { select: { devices: { where: { removedAt: null } } } } },
    });
    return toHostDto(h);
  }

  async list(): Promise<HostDto[]> {
    const rows = await this.prisma.host.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { devices: { where: { removedAt: null } } } } },
    });
    return rows.map(toHostDto);
  }

  async create(name: string, actorId: string, ip: string | null): Promise<HostTokenDto> {
    const agentToken = newAgentToken();
    try {
      const host = await this.prisma.host.create({
        data: { name, tokenHash: sha256Hex(agentToken) },
      });
      await this.audit.log({
        action: AuditAction.HOST_CREATE,
        userId: actorId,
        entityType: 'Host',
        entityId: host.id,
        metadata: { name },
        ip,
      });
      return { host: await this.dto(host.id), agentToken };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('A host with this name already exists');
      }
      throw e;
    }
  }

  async rotateToken(id: string, actorId: string, ip: string | null): Promise<HostTokenDto> {
    const agentToken = newAgentToken();
    await this.prisma.host.update({
      where: { id },
      data: { tokenHash: sha256Hex(agentToken), tokenRevokedAt: null, status: 'OFFLINE' },
    });
    this.agents.disconnect(id);
    await this.audit.log({
      action: AuditAction.HOST_ROTATE_TOKEN,
      userId: actorId,
      entityType: 'Host',
      entityId: id,
      ip,
    });
    return { host: await this.dto(id), agentToken };
  }

  async revoke(id: string, actorId: string, ip: string | null): Promise<HostDto> {
    const exists = await this.prisma.host.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException();
    await this.prisma.host.update({
      where: { id },
      data: { tokenRevokedAt: new Date(), status: 'REVOKED' },
    });
    this.agents.disconnect(id);
    await this.markHostOffline(id, 'REVOKED');
    await this.audit.log({
      action: AuditAction.HOST_REVOKE,
      userId: actorId,
      entityType: 'Host',
      entityId: id,
      ip,
    });
    return this.dto(id);
  }

  async onAgentHello(hostId: string, hello: AgentHello, ip: string | null): Promise<string[]> {
    await this.prisma.host.update({
      where: { id: hostId },
      data: {
        status: 'ONLINE',
        os: hello.os,
        agentVersion: hello.agentVersion,
        capabilities: hello.capabilities,
        ip,
        lastSeenAt: new Date(),
      },
    });
    this.events.hostUpdated(await this.dto(hostId));
    const devices = await this.prisma.device.findMany({
      where: { hostId, removedAt: null },
      select: { udid: true },
    });
    this.logger.log(`host ${hello.hostName} (${hostId}) online, agent ${hello.agentVersion}`);
    return devices.map((d) => d.udid);
  }

  async onHeartbeat(hostId: string): Promise<void> {
    await this.prisma.host.update({
      where: { id: hostId },
      data: { lastSeenAt: new Date(), status: 'ONLINE' },
    });
  }

  async markHostOffline(hostId: string, status: 'OFFLINE' | 'REVOKED' = 'OFFLINE'): Promise<void> {
    await this.prisma.host.updateMany({
      where: { id: hostId, status: { not: 'REVOKED' } },
      data: { status },
    });
    const devices = await this.prisma.device.findMany({
      where: { hostId, online: true },
      select: { id: true },
    });
    await this.prisma.device.updateMany({
      where: { hostId, online: true },
      data: { online: false, offlineSince: new Date() },
    });
    for (const d of devices) await this.devices.recompute(d.id);
    this.events.hostUpdated(await this.dto(hostId));
  }

  /** Hosts whose heartbeat went silent without a clean disconnect. */
  async sweepStaleHosts(): Promise<void> {
    const cutoff = new Date(Date.now() - this.env.HOST_HEARTBEAT_TIMEOUT_SEC * 1000);
    const stale = await this.prisma.host.findMany({
      where: { status: 'ONLINE', lastSeenAt: { lt: cutoff } },
      select: { id: true, name: true },
    });
    for (const h of stale) {
      this.logger.warn(`host ${h.name} missed heartbeats; marking offline`);
      this.agents.disconnect(h.id);
      await this.markHostOffline(h.id);
    }
  }

  async resync(id: string, actorId: string, ip: string | null): Promise<void> {
    const res = await this.agents.command(id, 'host:resync', {});
    await this.audit.log({
      action: AuditAction.HOST_RESYNC,
      userId: actorId,
      entityType: 'Host',
      entityId: id,
      ip,
      metadata: { ok: res.ok },
    });
    if (!res.ok) throw new ConflictException(res.error);
  }
}
