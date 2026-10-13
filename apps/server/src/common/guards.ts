import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { type Permission, type Role, canAll } from '@devicelab/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { sha256Hex } from './crypto';
import {
  AGENT_AUTH_KEY,
  type AuthHost,
  type AuthUser,
  type AuthedRequest,
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
} from './auth.decorators';

export interface AccessTokenPayload {
  sub: string;
  typ: 'access';
  role: Role;
}

/** Resolves a user id to a live, active user (role changes and deactivation apply immediately). */
@Injectable()
export class UserResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(userId: string): Promise<AuthUser | null> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, role: true, teamId: true, isActive: true },
    });
    if (!u || !u.isActive) return null;
    return { id: u.id, email: u.email, name: u.name, role: u.role, teamId: u.teamId };
  }
}

@Injectable()
export class HostTokenVerifier {
  constructor(private readonly prisma: PrismaService) {}

  async verify(token: string | undefined | null): Promise<AuthHost | null> {
    if (!token || token.length < 20 || token.length > 200) return null;
    const host = await this.prisma.host.findUnique({
      where: { tokenHash: sha256Hex(token) },
      select: { id: true, name: true, tokenRevokedAt: true },
    });
    if (!host || host.tokenRevokedAt) return null;
    return { id: host.id, name: host.name };
  }
}

/** Verify a user access token. Shared by the HTTP guard and the portal gateway. */
export async function verifyAccessToken(
  jwt: JwtService,
  users: UserResolver,
  token: string | undefined | null,
): Promise<AuthUser | null> {
  if (!token) return null;
  try {
    const payload = await jwt.verifyAsync<AccessTokenPayload>(token);
    if (payload.typ !== 'access' || typeof payload.sub !== 'string') return null;
    return await users.resolve(payload.sub);
  } catch {
    return null;
  }
}

/** Global guard #1: authenticates users (Bearer JWT) or agents (Agent token). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly users: UserResolver,
    private readonly hosts: HostTokenVerifier,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true; // WebSocket gateways authenticate on connect.
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ', 2);

    if (this.reflector.getAllAndOverride<boolean>(AGENT_AUTH_KEY, targets)) {
      const host = scheme === 'Agent' ? await this.hosts.verify(token) : null;
      if (!host) throw new UnauthorizedException('Invalid or revoked agent token');
      req.agentHost = host;
      return true;
    }

    const user = scheme === 'Bearer' ? await verifyAccessToken(this.jwt, this.users, token) : null;
    if (!user) throw new UnauthorizedException();
    req.user = user;
    return true;
  }
}

/** Global guard #2: RBAC. Default-deny for routes that forgot @Permissions(). */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== 'http') return true;
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(AGENT_AUTH_KEY, targets)) return true;

    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(
      PERMISSIONS_KEY,
      targets,
    );
    if (required === undefined) {
      throw new ForbiddenException('Route has no permission declaration');
    }
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user) throw new UnauthorizedException();
    if (!canAll(req.user.role, required)) {
      throw new ForbiddenException(`Missing permission: ${required.join(', ')}`);
    }
    return true;
  }
}
