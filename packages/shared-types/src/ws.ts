/**
 * Typed contracts for the two Socket.IO namespaces (JSON control channels).
 * The binary stream channel is defined in @devicelab/protocol.
 *
 * Rule: every event name used anywhere in the codebase must appear in one of
 * the interfaces below. No string-typed emits.
 */
import { z } from 'zod';
import type { AppInfo, DeviceDto, HostDto, ReservationDto, StreamQuality } from './dto';
import { streamQualitySchema } from './dto';
import { type ReleaseReason } from './enums';

export const AGENT_NAMESPACE = '/agent';
export const PORTAL_NAMESPACE = '/portal';
export const STREAM_AGENT_PATH = '/ws/stream/agent';
export const STREAM_PORTAL_PATH = '/ws/stream/portal';

// ===========================================================================
// Agent ⇄ Server
// ===========================================================================

export const agentHelloSchema = z.object({
  hostName: z.string().min(1).max(64),
  agentVersion: z.string().max(32),
  os: z.enum(['linux', 'darwin', 'win32']),
  capabilities: z.object({
    android: z.boolean(),
    ios: z.boolean(),
    appium: z.boolean(),
    mock: z.boolean(),
  }),
});
export type AgentHello = z.infer<typeof agentHelloSchema>;

export interface AgentWelcome {
  hostId: string;
  heartbeatIntervalMs: number;
  /** Devices the server already knows on this host, so the agent can re-sync. */
  knownSerials: string[];
}

export const agentHeartbeatSchema = z.object({
  uptimeSec: z.number().nonnegative(),
  load: z.number().nonnegative(),
  deviceCount: z.number().int().nonnegative(),
});
export type AgentHeartbeat = z.infer<typeof agentHeartbeatSchema>;

export const deviceReportSchema = z.object({
  serial: z.string().min(1).max(128),
  platform: z.enum(['ANDROID', 'IOS']),
  /** online = usable, unauthorized = USB debugging prompt not accepted, offline = present but not responding. */
  state: z.enum(['online', 'unauthorized', 'offline']),
  model: z.string().max(128),
  manufacturer: z.string().max(128),
  osVersion: z.string().max(32),
  screenW: z.number().int().nonnegative(),
  screenH: z.number().int().nonnegative(),
  batteryLevel: z.number().int().min(0).max(100).nullable(),
  temperatureC: z.number().nullable().optional(),
  network: z.string().max(64).nullable().optional(),
  storageFreeMb: z.number().int().nullable().optional(),
  storageTotalMb: z.number().int().nullable().optional(),
});
export type DeviceReport = z.infer<typeof deviceReportSchema>;

export const deviceHealthSchema = z.object({
  serial: z.string().min(1).max(128),
  level: z.enum(['info', 'warn', 'error']),
  message: z.string().max(500),
});
export type DeviceHealth = z.infer<typeof deviceHealthSchema>;

export const logLineSchema = z.object({
  ts: z.number(),
  level: z.enum(['V', 'D', 'I', 'W', 'E', 'F']),
  tag: z.string().max(256),
  pid: z.number().int().nullable(),
  tid: z.number().int().nullable(),
  message: z.string().max(8192),
});

export const sessionLogBatchSchema = z.object({
  sessionId: z.string().uuid(),
  lines: z.array(logLineSchema).max(2000),
});
export type SessionLogBatch = z.infer<typeof sessionLogBatchSchema>;

export const streamStatusSchema = z.object({
  sessionId: z.string().uuid(),
  state: z.enum(['starting', 'streaming', 'stalled', 'restarting', 'stopped', 'error']),
  message: z.string().max(500).optional(),
  /** The agent suspects FLAG_SECURE (frames are all black while the device is awake). */
  secureContentSuspected: z.boolean().optional(),
});
export type StreamStatus = z.infer<typeof streamStatusSchema>;

export const installProgressSchema = z.object({
  jobId: z.string().max(64),
  serial: z.string().max(128),
  percent: z.number().min(0).max(100),
  state: z.enum(['downloading', 'installing', 'done', 'error']),
  message: z.string().max(500).optional(),
});
export type InstallProgress = z.infer<typeof installProgressSchema>;

/** Generic ack for server → agent commands. */
export type AgentResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? { data?: undefined } : { data: T }))
  | { ok: false; error: string };

export interface StreamStartCommand {
  sessionId: string;
  serial: string;
  quality: StreamQuality;
  /** Path + query of the agent stream socket (includes the stream token); the agent resolves it against its serverUrl. */
  streamPath: string;
}

export interface InstallCommand {
  jobId: string;
  serial: string;
  sessionId: string | null;
  buildId: string;
  fileName: string;
  /** Path relative to the server origin; GET with header `Authorization: Agent <token>`. */
  downloadPath: string;
  checksumSha256: string;
}

export interface CleanupCommand {
  serial: string;
  sessionId: string | null;
  /** Packages installed during the session that must be removed. */
  uninstallPackages: string[];
  reboot: boolean;
}

export interface AgentToServerEvents {
  'agent:hello': (hello: AgentHello, ack: (res: AgentResult<AgentWelcome>) => void) => void;
  'agent:heartbeat': (hb: AgentHeartbeat) => void;
  'device:upsert': (report: DeviceReport) => void;
  'device:removed': (payload: { serial: string }) => void;
  'device:health': (payload: DeviceHealth) => void;
  'session:log': (batch: SessionLogBatch) => void;
  'stream:status': (status: StreamStatus) => void;
  'install:progress': (progress: InstallProgress) => void;
}

export interface ServerToAgentEvents {
  'stream:start': (cmd: StreamStartCommand, ack: (res: AgentResult) => void) => void;
  'stream:stop': (cmd: { sessionId: string }, ack: (res: AgentResult) => void) => void;
  'stream:quality': (
    cmd: { sessionId: string; quality: StreamQuality },
    ack: (res: AgentResult) => void,
  ) => void;
  'device:install': (
    cmd: InstallCommand,
    ack: (res: AgentResult<{ packageIds: string[] }>) => void,
  ) => void;
  'device:apps': (cmd: { serial: string }, ack: (res: AgentResult<AppInfo[]>) => void) => void;
  'device:app-action': (
    cmd: { serial: string; packageId: string; action: 'launch' | 'stop' | 'clear' | 'uninstall' },
    ack: (res: AgentResult) => void,
  ) => void;
  'device:screenshot': (
    cmd: { serial: string },
    ack: (res: AgentResult<{ png: Uint8Array | ArrayBuffer }>) => void,
  ) => void;
  'device:logs': (
    cmd: { serial: string; sessionId: string; action: 'start' | 'stop' },
    ack: (res: AgentResult) => void,
  ) => void;
  'device:cleanup': (cmd: CleanupCommand, ack: (res: AgentResult) => void) => void;
  'device:reboot': (cmd: { serial: string }, ack: (res: AgentResult) => void) => void;
  'host:resync': (cmd: Record<string, never>, ack: (res: AgentResult) => void) => void;
}

export const streamQualityUpdateSchema = z.object({
  sessionId: z.string().uuid(),
  quality: streamQualitySchema,
});

// ===========================================================================
// Portal ⇄ Server
// ===========================================================================

export interface InstallProgressEvent extends InstallProgress {
  deviceId: string;
}

export interface ServerToPortalEvents {
  'device:updated': (device: DeviceDto) => void;
  'device:removed': (payload: { id: string }) => void;
  'host:updated': (host: HostDto) => void;
  'reservation:updated': (reservation: ReservationDto) => void;
  'reservation:idle-warning': (payload: { reservationId: string; releaseInSec: number }) => void;
  'reservation:released': (payload: { reservationId: string; reason: ReleaseReason }) => void;
  'session:log': (batch: SessionLogBatch) => void;
  'session:stream-status': (status: StreamStatus) => void;
  'install:progress': (progress: InstallProgressEvent) => void;
}

export const sessionRefSchema = z.object({ sessionId: z.string().uuid() });
export const sessionLogsControlSchema = z.object({
  sessionId: z.string().uuid(),
  action: z.enum(['start', 'stop']),
});

export type PortalAck = (res: { ok: true } | { ok: false; error: string }) => void;

export interface PortalToServerEvents {
  'session:subscribe': (payload: { sessionId: string }, ack: PortalAck) => void;
  'session:unsubscribe': (payload: { sessionId: string }, ack: PortalAck) => void;
  'session:logs': (
    payload: { sessionId: string; action: 'start' | 'stop' },
    ack: PortalAck,
  ) => void;
  'session:quality': (
    payload: { sessionId: string; quality: StreamQuality },
    ack: PortalAck,
  ) => void;
}
