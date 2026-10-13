import {
  AGENT_NAMESPACE,
  type AgentToServerEvents,
  type ServerToAgentEvents,
} from '@devicelab/shared-types';
import os from 'node:os';
import { type Socket, io } from 'socket.io-client';
import { type AgentConfig } from './config';
import { type DeviceManager, type ManagerOutbox } from './device-manager';
import { type Logger } from './logger';
import { AGENT_VERSION } from './version';

type AgentSocket = Socket<ServerToAgentEvents, AgentToServerEvents>;

/**
 * JSON control channel to the server: hello → heartbeat every 5 s, device
 * events up, commands down. Socket.IO reconnects with exponential backoff
 * (1 s → 30 s, jittered).
 */
export class ServerLink implements ManagerOutbox {
  private socket: AgentSocket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly startedAt = Date.now();
  connected = false;
  hostId: string | null = null;
  lastError: string | null = null;

  constructor(
    private readonly cfg: AgentConfig,
    private readonly manager: DeviceManager,
    private readonly logger: Logger,
  ) {}

  start(): void {
    const socket: AgentSocket = io(new URL(AGENT_NAMESPACE, this.cfg.serverUrl).toString(), {
      auth: { token: this.cfg.agentToken },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      randomizationFactor: 0.5,
      ca: this.cfg.ca?.toString('utf8'),
    });
    this.socket = socket;

    socket.on('connect', () => void this.onConnect());
    socket.on('disconnect', (reason) => {
      this.connected = false;
      this.stopHeartbeat();
      this.logger.warn({ reason }, 'disconnected from server');
    });
    socket.on('connect_error', (err) => {
      this.lastError = err.message;
      if (err.message === 'unauthorized') {
        this.logger.error(
          'server rejected the agent token — check agentToken in agent.config.json (Admin → Hosts)',
        );
      } else {
        this.logger.warn({ err: err.message }, 'cannot reach server, retrying');
      }
    });

    const m = this.manager;
    socket.on('stream:start', (cmd, ack) => void m.startStream(cmd).then(ack));
    socket.on('stream:stop', (cmd, ack) => void m.stopStream(cmd.sessionId).then(ack));
    socket.on(
      'stream:quality',
      (cmd, ack) => void m.setQuality(cmd.sessionId, cmd.quality).then(ack),
    );
    socket.on('device:install', (cmd, ack) => void m.install(cmd).then(ack));
    socket.on('device:apps', (cmd, ack) => void m.listApps(cmd.serial).then(ack));
    socket.on(
      'device:app-action',
      (cmd, ack) => void m.appAction(cmd.serial, cmd.packageId, cmd.action).then(ack),
    );
    socket.on('device:screenshot', (cmd, ack) => void m.screenshot(cmd.serial).then(ack));
    socket.on(
      'device:logs',
      (cmd, ack) => void m.logsControl(cmd.serial, cmd.sessionId, cmd.action).then(ack),
    );
    socket.on('device:cleanup', (cmd, ack) => void m.cleanup(cmd).then(ack));
    socket.on('device:reboot', (cmd, ack) => void m.reboot(cmd.serial).then(ack));
    socket.on('host:resync', (_cmd, ack) => void m.resync().then(() => ack({ ok: true })));
  }

  private async onConnect(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    try {
      const res = await socket.timeout(10_000).emitWithAck('agent:hello', {
        hostName: this.cfg.hostName,
        agentVersion: AGENT_VERSION,
        os: os.platform() === 'darwin' ? 'darwin' : os.platform() === 'win32' ? 'win32' : 'linux',
        capabilities: {
          android: !this.cfg.mock,
          ios: !this.cfg.mock && os.platform() === 'darwin',
          appium: false,
          mock: this.cfg.mock,
        },
      });
      if (!res.ok) throw new Error(res.error);
      this.connected = true;
      this.lastError = null;
      this.hostId = res.data.hostId;
      this.logger.info({ hostId: res.data.hostId }, 'registered with server');
      this.startHeartbeat(res.data.heartbeatIntervalMs);
      // Devices the server knows but we don't have any more → tell it they're gone.
      const present = new Set(this.manager.devices().map((d) => d.serial));
      for (const serial of res.data.knownSerials) if (!present.has(serial)) this.removed(serial);
      await this.manager.resync();
    } catch (err) {
      this.logger.error({ err: (err as Error).message }, 'hello failed; reconnecting');
      socket.disconnect();
      setTimeout(() => socket.connect(), 5000);
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      this.socket?.emit('agent:heartbeat', {
        uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
        load: os.loadavg()[0] ?? 0,
        deviceCount: this.manager.deviceCount,
      });
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  stop(): void {
    this.stopHeartbeat();
    this.socket?.disconnect();
  }

  // ManagerOutbox — events are only sent while registered; a reconnect re-syncs everything.
  private emitIfConnected<E extends keyof AgentToServerEvents>(
    event: E,
    ...args: Parameters<AgentToServerEvents[E]>
  ): void {
    if (this.connected && this.socket) this.socket.emit(event, ...args);
  }

  device: ManagerOutbox['device'] = (r) => this.emitIfConnected('device:upsert', r);
  removed: ManagerOutbox['removed'] = (serial) =>
    this.emitIfConnected('device:removed', { serial });
  health: ManagerOutbox['health'] = (h) => this.emitIfConnected('device:health', h);
  log: ManagerOutbox['log'] = (batch) => this.emitIfConnected('session:log', batch);
  streamStatus: ManagerOutbox['streamStatus'] = (s) => this.emitIfConnected('stream:status', s);
  installProgress: ManagerOutbox['installProgress'] = (p) =>
    this.emitIfConnected('install:progress', p);
}
