import { Role } from './enums';

export const Permission = {
  DEVICE_READ: 'device:read',
  DEVICE_USE: 'device:use',
  DEVICE_OBSERVE: 'device:observe',
  DEVICE_ADMIN: 'device:admin',
  RESERVATION_FORCE_RELEASE: 'reservation:force_release',
  RESERVATION_READ_ALL: 'reservation:read_all',
  BUILD_READ: 'build:read',
  BUILD_UPLOAD: 'build:upload',
  BUILD_INSTALL: 'build:install',
  ARTIFACT_READ: 'artifact:read',
  USER_ADMIN: 'user:admin',
  HOST_ADMIN: 'host:admin',
  AUDIT_READ: 'audit:read',
  SETTINGS_ADMIN: 'settings:admin',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

const ALL = Object.values(Permission);

const TESTER: Permission[] = [
  Permission.DEVICE_READ,
  Permission.DEVICE_USE,
  Permission.BUILD_READ,
  Permission.BUILD_UPLOAD,
  Permission.BUILD_INSTALL,
  Permission.ARTIFACT_READ,
];

/**
 * Role → permission matrix. The server enforces it on every REST route
 * (@Permissions decorator) and every WebSocket event; the portal uses it only
 * to hide controls.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  [Role.ADMIN]: ALL,
  [Role.LEAD]: [
    ...TESTER,
    Permission.DEVICE_OBSERVE,
    Permission.RESERVATION_FORCE_RELEASE,
    Permission.RESERVATION_READ_ALL,
    Permission.AUDIT_READ,
  ],
  [Role.TESTER]: TESTER,
  [Role.VIEWER]: [Permission.DEVICE_READ, Permission.DEVICE_OBSERVE, Permission.BUILD_READ],
};

export function can(role: Role | undefined | null, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function canAll(role: Role | undefined | null, permissions: readonly Permission[]): boolean {
  return permissions.every((p) => can(role, p));
}
