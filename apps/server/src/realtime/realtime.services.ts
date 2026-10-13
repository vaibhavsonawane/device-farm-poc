import { Global, Injectable, Logger, Module } from '@nestjs/common';
import type {
  AgentResult,
  AgentToServerEvents,
  DeviceDto,
  HostDto,
  InstallProgressEvent,
  ReleaseReason,
  ReservationDto,
  ServerToAgentEvents,
  ServerToPortalEvents,
  SessionLogBatch,
  StreamStatus,
} from '@devicelab/shared-types';
import { Subject } from 'rxjs';
import type { Namespace, Socket } from 'socket.io';

export type PortalNamespace = Namespace<Record<string, never>, ServerToPortalEvents>;
export type AgentSocket = Socket<
  AgentToServerEvents,
  ServerToAgentEvents,
  Record<string, never>,
  { hostId: string }
>;

export const Rooms = {
  inventory: 'inventory',
  user: (id: string): string => `user:${id}`,
  session: (id: string): string => `session:${id}`,
  /** Users allowed to see every reservation (leads/admins). */
  reservationsAll: 'reservations:all',
};

/** Typed emitter towards browsers. The PortalGateway attaches the namespace at startup. */
@Injectable()
export class PortalEvents {
  private nsp: PortalNamespace | null = null;

  attach(nsp: PortalNamespace): void {
    this.nsp = nsp;
  }

  deviceUpdated(device: DeviceDto): void {
    this.nsp?.to(Rooms.inventory).emit('device:updated', device);
  }

  deviceRemoved(id: string): void {
    this.nsp?.to(Rooms.inventory).emit('device:removed', { id });
  }

  hostUpdated(host: HostDto): void {
    this.nsp?.to(Rooms.inventory).emit('host:updated', host);
  }

  reservationUpdated(r: ReservationDto): void {
    this.nsp?.to([Rooms.user(r.userId), Rooms.reservationsAll]).emit('reservation:updated', r);
  }

  idleWarning(userId: string, reservationId: string, releaseInSec: number): void {
    this.nsp
      ?.to(Rooms.user(userId))
      .emit('reservation:idle-warning', { reservationId, releaseInSec });
  }

  released(userId: string, reservationId: string, reason: ReleaseReason): void {
    this.nsp?.to(Rooms.user(userId)).emit('reservation:released', { reservationId, reason });
  }

  sessionLog(batch: SessionLogBatch): void {
    this.nsp?.to(Rooms.session(batch.sessionId)).emit('session:log', batch);
  }

  streamStatus(status: StreamStatus): void {
    this.nsp?.to(Rooms.session(status.sessionId)).emit('session:stream-status', status);
  }

  installProgress(userId: string, progress: InstallProgressEvent): void {
    this.nsp?.to(Rooms.user(userId)).emit('install:progress', progress);
  }
}

export class AgentUnavailableError extends Error {
  constructor(hostId: string) {
    super(`Host agent ${hostId} is not connected`);
  }
}

type CommandName = keyof ServerToAgentEvents;
type CommandPayload<E extends CommandName> = Parameters<ServerToAgentEvents[E]>[0];
type CommandResult<E extends CommandName> = Parameters<Parameters<ServerToAgentEvents[E]>[1]>[0];

/** Connected host agents, keyed by host id. Single server instance (see ARCHITECTURE.md). */
@Injectable()
export class AgentRegistry {
  private readonly logger = new Logger(AgentRegistry.name);
  private readonly sockets = new Map<string, AgentSocket>();

  register(hostId: string, socket: AgentSocket): void {
    const prev = this.sockets.get(hostId);
    if (prev && prev.id !== socket.id) {
      this.logger.warn(`host ${hostId} connected twice; dropping the older connection`);
      prev.disconnect(true);
    }
    this.sockets.set(hostId, socket);
  }

  unregister(hostId: string, socketId: string): boolean {
    if (this.sockets.get(hostId)?.id !== socketId) return false;
    this.sockets.delete(hostId);
    return true;
  }

  isConnected(hostId: string): boolean {
    return this.sockets.get(hostId)?.connected ?? false;
  }

  disconnect(hostId: string): void {
    this.sockets.get(hostId)?.disconnect(true);
  }

  /** Send a command and wait for the agent's ack. Never rejects: failures come back as { ok: false }. */
  async command<E extends CommandName>(
    hostId: string,
    event: E,
    payload: CommandPayload<E>,
    timeoutMs = 15_000,
  ): Promise<CommandResult<E> | { ok: false; error: string }> {
    const socket = this.sockets.get(hostId);
    if (!socket?.connected) return { ok: false, error: new AgentUnavailableError(hostId).message };
    try {
      // Socket.IO's typed emitWithAck cannot express a generic event name; the cast is safe
      // because CommandPayload/CommandResult are derived from ServerToAgentEvents[E].
      const timed = socket.timeout(timeoutMs);
      const emit = timed.emitWithAck.bind(timed) as unknown as (
        ev: E,
        p: CommandPayload<E>,
      ) => Promise<CommandResult<E>>;
      const res = await emit(event, payload);
      return res ?? ({ ok: false, error: 'empty ack' } satisfies AgentResult);
    } catch (err) {
      return { ok: false, error: `agent did not answer ${event}: ${(err as Error).message}` };
    }
  }
}

export type DomainEvent =
  | { type: 'reservation.released'; reservationId: string; deviceId: string; reason: ReleaseReason }
  | { type: 'session.ended'; sessionId: string };

/** In-process domain events (decouples reservations ↔ stream relay). */
@Injectable()
export class DomainEvents {
  readonly events$ = new Subject<DomainEvent>();

  emit(e: DomainEvent): void {
    this.events$.next(e);
  }
}

@Global()
@Module({
  providers: [PortalEvents, AgentRegistry, DomainEvents],
  exports: [PortalEvents, AgentRegistry, DomainEvents],
})
export class RealtimeModule {}
