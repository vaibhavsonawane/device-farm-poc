import {
  type CanActivate,
  type ExecutionContext,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { type Permission, type Role } from '@devicelab/shared-types';
import { type Request } from 'express';

export const IS_PUBLIC_KEY = 'devicelab:public';
export const PERMISSIONS_KEY = 'devicelab:permissions';
export const AGENT_AUTH_KEY = 'devicelab:agent-auth';

/** Skip JWT authentication (login, refresh, health). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Required permissions for a route. Every non-public route MUST declare this —
 * the PermissionsGuard denies routes without it. `@Permissions()` with no
 * arguments means "any authenticated user".
 */
export const Permissions = (...permissions: Permission[]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Route is called by host agents (Authorization: Agent <token>) instead of users. */
export const AgentAuth = (): MethodDecorator & ClassDecorator => SetMetadata(AGENT_AUTH_KEY, true);

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  teamId: string | null;
}

export interface AuthHost {
  id: string;
  name: string;
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
  agentHost?: AuthHost;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user) throw new Error('CurrentUser used on a route without user authentication');
    return req.user;
  },
);

export const CurrentHost = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthHost => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.agentHost) throw new Error('CurrentHost used on a route without agent authentication');
    return req.agentHost;
  },
);

export const ClientIp = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null => {
    const req = ctx.switchToHttp().getRequest<Request>();
    return req.ip ?? null;
  },
);

export type Guard = CanActivate;
