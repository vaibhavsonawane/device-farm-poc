import { type ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Permission, Role } from '@devicelab/shared-types';
import { describe, expect, it } from 'vitest';
import { AGENT_AUTH_KEY, IS_PUBLIC_KEY, PERMISSIONS_KEY } from './auth.decorators';
import { PermissionsGuard } from './guards';

function ctx(meta: Record<string, unknown>, user?: { role: Role }): ExecutionContext {
  const handler = (): void => undefined;
  for (const [k, v] of Object.entries(meta)) Reflect.defineMetadata(k, v, handler);
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard', () => {
  const guard = new PermissionsGuard(new Reflector());

  it('denies routes that forgot to declare permissions (default deny)', () => {
    expect(() => guard.canActivate(ctx({}, { role: Role.ADMIN }))).toThrow(ForbiddenException);
  });

  it('allows any authenticated user when @Permissions() is empty', () => {
    expect(guard.canActivate(ctx({ [PERMISSIONS_KEY]: [] }, { role: Role.VIEWER }))).toBe(true);
  });

  it('rejects unauthenticated requests on protected routes', () => {
    expect(() => guard.canActivate(ctx({ [PERMISSIONS_KEY]: [] }))).toThrow(UnauthorizedException);
  });

  it('enforces the role matrix', () => {
    const route = { [PERMISSIONS_KEY]: [Permission.USER_ADMIN] };
    expect(guard.canActivate(ctx(route, { role: Role.ADMIN }))).toBe(true);
    expect(() => guard.canActivate(ctx(route, { role: Role.LEAD }))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx(route, { role: Role.TESTER }))).toThrow(ForbiddenException);
  });

  it('requires every listed permission', () => {
    const route = {
      [PERMISSIONS_KEY]: [Permission.DEVICE_USE, Permission.RESERVATION_FORCE_RELEASE],
    };
    expect(guard.canActivate(ctx(route, { role: Role.LEAD }))).toBe(true);
    expect(() => guard.canActivate(ctx(route, { role: Role.TESTER }))).toThrow(ForbiddenException);
  });

  it('viewers can never use devices', () => {
    expect(() =>
      guard.canActivate(ctx({ [PERMISSIONS_KEY]: [Permission.DEVICE_USE] }, { role: Role.VIEWER })),
    ).toThrow(ForbiddenException);
  });

  it('skips public and agent-authenticated routes', () => {
    expect(guard.canActivate(ctx({ [IS_PUBLIC_KEY]: true }))).toBe(true);
    expect(guard.canActivate(ctx({ [AGENT_AUTH_KEY]: true }))).toBe(true);
  });
});
