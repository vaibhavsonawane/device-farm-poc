import { describe, expect, it } from 'vitest';
import { Permission, ROLE_PERMISSIONS, can, canAll } from './permissions';
import { Role } from './enums';

describe('permission matrix', () => {
  it('gives admins every permission', () => {
    for (const p of Object.values(Permission)) expect(can(Role.ADMIN, p)).toBe(true);
  });

  it('viewers can watch but never control or upload', () => {
    expect(can(Role.VIEWER, Permission.DEVICE_OBSERVE)).toBe(true);
    expect(can(Role.VIEWER, Permission.DEVICE_USE)).toBe(false);
    expect(can(Role.VIEWER, Permission.BUILD_UPLOAD)).toBe(false);
  });

  it('testers cannot force-release or administer', () => {
    expect(can(Role.TESTER, Permission.DEVICE_USE)).toBe(true);
    expect(can(Role.TESTER, Permission.RESERVATION_FORCE_RELEASE)).toBe(false);
    expect(can(Role.TESTER, Permission.USER_ADMIN)).toBe(false);
    expect(can(Role.TESTER, Permission.HOST_ADMIN)).toBe(false);
  });

  it('leads can force-release and read audit but not manage users', () => {
    expect(canAll(Role.LEAD, [Permission.RESERVATION_FORCE_RELEASE, Permission.AUDIT_READ])).toBe(
      true,
    );
    expect(can(Role.LEAD, Permission.USER_ADMIN)).toBe(false);
  });

  it('denies unknown or missing roles', () => {
    expect(can(undefined, Permission.DEVICE_READ)).toBe(false);
    expect(can('HACKER' as Role, Permission.DEVICE_READ)).toBe(false);
  });

  it('has a row for every role', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(Object.values(Role).sort());
  });
});
