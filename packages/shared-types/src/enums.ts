// Enum values mirror the Prisma enums in apps/server/prisma/schema.prisma — keep them in sync.

export const Role = {
  ADMIN: 'ADMIN',
  LEAD: 'LEAD',
  TESTER: 'TESTER',
  VIEWER: 'VIEWER',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const Platform = {
  ANDROID: 'ANDROID',
  IOS: 'IOS',
} as const;
export type Platform = (typeof Platform)[keyof typeof Platform];

export const DeviceStatus = {
  AVAILABLE: 'AVAILABLE',
  IN_USE: 'IN_USE',
  OFFLINE: 'OFFLINE',
  MAINTENANCE: 'MAINTENANCE',
} as const;
export type DeviceStatus = (typeof DeviceStatus)[keyof typeof DeviceStatus];

export const HostStatus = {
  ONLINE: 'ONLINE',
  OFFLINE: 'OFFLINE',
  REVOKED: 'REVOKED',
} as const;
export type HostStatus = (typeof HostStatus)[keyof typeof HostStatus];

export const ReservationStatus = {
  SCHEDULED: 'SCHEDULED',
  ACTIVE: 'ACTIVE',
  RELEASED: 'RELEASED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;
export type ReservationStatus = (typeof ReservationStatus)[keyof typeof ReservationStatus];

export const ReservationKind = {
  INTERACTIVE: 'INTERACTIVE',
  AUTOMATION: 'AUTOMATION',
} as const;
export type ReservationKind = (typeof ReservationKind)[keyof typeof ReservationKind];

/** Why a reservation ended — stored on Session.disconnectReason and sent to the portal. */
export const ReleaseReason = {
  USER: 'USER',
  IDLE: 'IDLE',
  EXPIRED: 'EXPIRED',
  FORCED: 'FORCED',
  DEVICE_OFFLINE: 'DEVICE_OFFLINE',
} as const;
export type ReleaseReason = (typeof ReleaseReason)[keyof typeof ReleaseReason];

export const ArtifactType = {
  SCREENSHOT: 'SCREENSHOT',
  RECORDING: 'RECORDING',
  LOGCAT: 'LOGCAT',
  SYSLOG: 'SYSLOG',
  APPIUM_LOG: 'APPIUM_LOG',
} as const;
export type ArtifactType = (typeof ArtifactType)[keyof typeof ArtifactType];

export const LogLevel = {
  VERBOSE: 'V',
  DEBUG: 'D',
  INFO: 'I',
  WARN: 'W',
  ERROR: 'E',
  FATAL: 'F',
} as const;
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

export const LOG_LEVEL_ORDER: readonly LogLevel[] = ['V', 'D', 'I', 'W', 'E', 'F'];
