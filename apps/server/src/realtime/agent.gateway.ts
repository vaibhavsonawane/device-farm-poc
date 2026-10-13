import { Logger } from '@nestjs/common';
import { type OnGatewayConnection, type OnGatewayInit, WebSocketGateway } from '@nestjs/websockets';
import {
  AGENT_NAMESPACE,
  type AgentToServerEvents,
  type ServerToAgentEvents,
  agentHeartbeatSchema,
  agentHelloSchema,
  deviceHealthSchema,
  deviceReportSchema,
  installProgressSchema,
  sessionLogBatchSchema,
  streamStatusSchema,
} from '@devicelab/shared-types';
import { type Namespace } from 'socket.io';
import { z } from 'zod';
import { AuditAction, AuditService } from '../audit/audit.service';
import { HostTokenVerifier } from '../common/guards';
import { safeParse } from '../common/zod';
import { BuildsService } from '../builds/builds.service';
import { DevicesService } from '../devices/devices.service';
import { HostsService } from '../hosts/hosts.service';
import { PrismaService } from '../prisma/prisma.service';
import { AgentRegistry, type AgentSocket, PortalEvents } from './realtime.services';

const HEARTBEAT_INTERVAL_MS = 5000;
const serialSchema = z.object({ serial: z.string().min(1).max(128) });

/** JSON control channel for host agents. Unknown or revoked hosts are rejected at handshake. */
@WebSocketGateway({ namespace: AGENT_NAMESPACE })
export class AgentGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(AgentGateway.name);

  constructor(
    private readonly verifier: HostTokenVerifier,
    private readonly registry: AgentRegistry,
    private readonly hosts: HostsService,
    private readonly devices: DevicesService,
    private readonly builds: BuildsService,
    private readonly portal: PortalEvents,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  afterInit(nsp: Namespace<AgentToServerEvents, ServerToAgentEvents>): void {
    nsp.use((socket, next) => {
      const auth = socket.handshake.auth as { token?: unknown } | undefined;
      const token = typeof auth?.token === 'string' ? auth.token : null;
      void this.verifier.verify(token).then((host) => {
        if (!host) {
          const ip = socket.handshake.address;
          this.logger.warn(`rejected agent connection from ${ip}: invalid or revoked token`);
          void this.audit.log({
            action: AuditAction.HOST_REJECTED,
            ip,
            metadata: { reason: 'invalid_token' },
          });
          return next(new Error('unauthorized'));
        }
        (socket.data as { hostId: string }).hostId = host.id;
        next();
      });
    });
  }

  handleConnection(socket: AgentSocket): void {
    const hostId = socket.data.hostId;
    const ip = socket.handshake.address;
    this.registry.register(hostId, socket);

    socket.on('agent:hello', (raw, ack) => {
      const hello = safeParse(agentHelloSchema, raw);
      if (!hello) return ack({ ok: false, error: 'invalid hello' });
      void this.hosts
        .onAgentHello(hostId, hello, ip)
        .then((knownSerials) =>
          ack({
            ok: true,
            data: { hostId, heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS, knownSerials },
          }),
        )
        .catch((err: Error) => ack({ ok: false, error: err.message }));
    });

    socket.on('agent:heartbeat', (raw) => {
      if (safeParse(agentHeartbeatSchema, raw)) void this.hosts.onHeartbeat(hostId);
    });

    socket.on('device:upsert', (raw) => {
      const report = safeParse(deviceReportSchema, raw);
      if (!report) return this.logger.warn(`host ${hostId}: invalid device report`);
      void this.devices
        .upsertFromReport(hostId, report)
        .catch((err: Error) => this.logger.error(`device upsert: ${err.message}`));
    });

    socket.on('device:removed', (raw) => {
      const p = safeParse(serialSchema, raw);
      if (p) void this.devices.markDisconnected(hostId, p.serial);
    });

    socket.on('device:health', (raw) => {
      const h = safeParse(deviceHealthSchema, raw);
      if (h) void this.devices.setHealth(hostId, h);
    });

    socket.on('session:log', (raw) => {
      const batch = safeParse(sessionLogBatchSchema, raw);
      if (batch) void this.forIfOwned(hostId, batch.sessionId, () => this.portal.sessionLog(batch));
    });

    socket.on('stream:status', (raw) => {
      const status = safeParse(streamStatusSchema, raw);
      if (status)
        void this.forIfOwned(hostId, status.sessionId, () => this.portal.streamStatus(status));
    });

    socket.on('install:progress', (raw) => {
      const p = safeParse(installProgressSchema, raw);
      if (p) this.builds.onProgress(p);
    });

    socket.on('disconnect', (reason) => {
      if (this.registry.unregister(hostId, socket.id)) {
        this.logger.warn(`host ${hostId} disconnected: ${reason}`);
        void this.hosts.markHostOffline(hostId);
      }
    });
  }

  /** Only relay session events from the host that actually owns the session's device. */
  private async forIfOwned(hostId: string, sessionId: string, fn: () => void): Promise<void> {
    const s = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { reservation: { select: { device: { select: { hostId: true } } } } },
    });
    if (s?.reservation.device.hostId === hostId) fn();
  }
}
