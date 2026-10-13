import { z } from 'zod';
import {
  type ArtifactType,
  type DeviceStatus,
  type HostStatus,
  Platform,
  type ReleaseReason,
  type ReservationKind,
  type ReservationStatus,
  Role,
} from './enums';

// ---------------------------------------------------------------------------
// Response DTOs (what the server sends). Dates are ISO strings on the wire.
// ---------------------------------------------------------------------------

export interface UserDto {
  id: string;
  name: string;
  email: string;
  role: Role;
  teamId: string | null;
  teamName: string | null;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface TeamDto {
  id: string;
  name: string;
}

export interface ProjectDto {
  id: string;
  name: string;
  code: string;
  teamId: string | null;
}

export interface HostCapabilities {
  android: boolean;
  ios: boolean;
  appium: boolean;
  mock: boolean;
}

export interface HostDto {
  id: string;
  name: string;
  os: string;
  ip: string | null;
  agentVersion: string | null;
  status: HostStatus;
  lastSeenAt: string | null;
  capabilities: HostCapabilities | null;
  deviceCount: number;
  createdAt: string;
}

export interface DeviceDto {
  id: string;
  udid: string;
  platform: Platform;
  name: string | null;
  model: string;
  manufacturer: string;
  osVersion: string;
  screenW: number;
  screenH: number;
  hostId: string;
  hostName: string;
  status: DeviceStatus;
  tags: string[];
  projectId: string | null;
  projectName: string | null;
  batteryLevel: number | null;
  simNumber: string | null;
  notes: string | null;
  /** Set when status = IN_USE. */
  currentReservation: {
    id: string;
    userId: string;
    userName: string;
    kind: ReservationKind;
    endAt: string;
  } | null;
  /** Last health message reported by the agent (e.g. "unauthorized — accept the RSA prompt"). */
  health: { level: 'info' | 'warn' | 'error'; message: string; at: string } | null;
  lastSeenAt: string | null;
}

export interface ReservationDto {
  id: string;
  deviceId: string;
  deviceModel: string;
  userId: string;
  userName: string;
  kind: ReservationKind;
  status: ReservationStatus;
  purpose: string | null;
  startAt: string;
  endAt: string;
  releasedAt: string | null;
  releaseReason: ReleaseReason | null;
  activeSessionId: string | null;
}

export interface SessionDto {
  id: string;
  reservationId: string;
  deviceId: string;
  startedAt: string;
  endedAt: string | null;
  disconnectReason: string | null;
}

/** Returned by POST /sessions and POST /sessions/:id/ticket. */
export interface SessionJoinDto {
  session: SessionDto;
  /** 'controller' may send input; 'observer' is read-only. */
  role: 'controller' | 'observer';
  /** Short-lived token for the binary stream socket. */
  streamTicket: string;
  /** Path of the binary stream socket, relative to the server origin. */
  streamPath: string;
}

export interface BuildDto {
  id: string;
  projectId: string | null;
  platform: Platform;
  fileName: string;
  appName: string | null;
  version: string | null;
  buildNumber: string | null;
  packageId: string | null;
  sizeBytes: number;
  checksumSha256: string;
  uploadedById: string;
  uploadedByName: string;
  uploadedAt: string;
  releaseNotes: string | null;
}

export interface ArtifactDto {
  id: string;
  sessionId: string | null;
  deviceId: string | null;
  type: ArtifactType;
  fileName: string;
  sizeBytes: number;
  createdAt: string;
}

export interface AuditLogDto {
  id: string;
  userId: string | null;
  userName: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

export interface AuthTokensDto {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  user: UserDto;
}

export interface AppInfo {
  packageId: string;
  label: string | null;
  versionName: string | null;
  system: boolean;
}

export interface LogLine {
  /** Epoch ms. */
  ts: number;
  level: 'V' | 'D' | 'I' | 'W' | 'E' | 'F';
  tag: string;
  pid: number | null;
  tid: number | null;
  message: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PublicSettingsDto {
  defaultReservationMinutes: number;
  maxReservationMinutes: number;
  idleWarnMinutes: number;
  idleReleaseMinutes: number;
}

// ---------------------------------------------------------------------------
// Stream quality
// ---------------------------------------------------------------------------

export const streamQualitySchema = z.object({
  /** Longest side of the encoded frame, in pixels. 0 = native. */
  maxSize: z.number().int().min(0).max(4096),
  /** Bits per second. */
  bitRate: z.number().int().min(250_000).max(32_000_000),
  maxFps: z.number().int().min(1).max(60),
});
export type StreamQuality = z.infer<typeof streamQualitySchema>;

export const STREAM_QUALITY_PRESETS = {
  LOW: { maxSize: 800, bitRate: 1_500_000, maxFps: 24 },
  MEDIUM: { maxSize: 1280, bitRate: 4_000_000, maxFps: 30 },
  HIGH: { maxSize: 1920, bitRate: 8_000_000, maxFps: 60 },
} as const satisfies Record<string, StreamQuality>;
export type StreamQualityPreset = keyof typeof STREAM_QUALITY_PRESETS;

// ---------------------------------------------------------------------------
// Request schemas (validated on the server with ZodPipe, reused by the portal)
// ---------------------------------------------------------------------------

export const loginRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(20).max(512),
});
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const passwordSchema = z
  .string()
  .min(10, 'At least 10 characters')
  .max(128)
  .regex(/[A-Z]/, 'Needs an upper-case letter')
  .regex(/[a-z]/, 'Needs a lower-case letter')
  .regex(/[0-9]/, 'Needs a digit');

export const createUserSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  password: passwordSchema,
  role: z.enum([Role.ADMIN, Role.LEAD, Role.TESTER, Role.VIEWER]),
  teamId: z.string().uuid().nullable().optional(),
});
export type CreateUserRequest = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: z.enum([Role.ADMIN, Role.LEAD, Role.TESTER, Role.VIEWER]).optional(),
  teamId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional(),
  password: passwordSchema.optional(),
});
export type UpdateUserRequest = z.infer<typeof updateUserSchema>;

export const createHostSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Letters, digits, dot, dash and underscore only'),
});
export type CreateHostRequest = z.infer<typeof createHostSchema>;

/** Returned exactly once, when a host is created or its token rotated. */
export interface HostTokenDto {
  host: HostDto;
  agentToken: string;
}

export const updateDeviceSchema = z.object({
  name: z.string().trim().max(80).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
  projectId: z.string().uuid().nullable().optional(),
  maintenance: z.boolean().optional(),
  simNumber: z.string().trim().max(20).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});
export type UpdateDeviceRequest = z.infer<typeof updateDeviceSchema>;

export const deviceQuerySchema = z.object({
  platform: z.enum([Platform.ANDROID, Platform.IOS]).optional(),
  status: z.enum(['AVAILABLE', 'IN_USE', 'OFFLINE', 'MAINTENANCE']).optional(),
  projectId: z.string().uuid().optional(),
  q: z.string().max(100).optional(),
});

export const createReservationSchema = z.object({
  deviceId: z.string().uuid(),
  durationMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .optional(),
  purpose: z.string().trim().max(200).optional(),
});
export type CreateReservationRequest = z.infer<typeof createReservationSchema>;

export const extendReservationSchema = z.object({
  minutes: z.number().int().min(5).max(240),
});
export type ExtendReservationRequest = z.infer<typeof extendReservationSchema>;

export const createSessionSchema = z.object({
  reservationId: z.string().uuid(),
  quality: streamQualitySchema.optional(),
});
export type CreateSessionRequest = z.infer<typeof createSessionSchema>;

export const observeSessionSchema = z.object({
  sessionId: z.string().uuid(),
});

export const installRequestSchema = z.object({
  buildId: z.string().uuid(),
  deviceIds: z.array(z.string().uuid()).min(1).max(50),
});
export type InstallRequest = z.infer<typeof installRequestSchema>;

export const appActionSchema = z.object({
  packageId: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Invalid package id'),
  action: z.enum(['launch', 'stop', 'clear', 'uninstall']),
});
export type AppActionRequest = z.infer<typeof appActionSchema>;
