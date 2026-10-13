import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { type AuthTokensDto, type LoginRequest } from '@devicelab/shared-types';
import { randomUUID } from 'node:crypto';
import { AuditAction, AuditService } from '../audit/audit.service';
import { InjectEnv } from '../config/config.module';
import { type Env } from '../config/env';
import { randomToken, safeEqualHex, sha256Hex } from '../common/crypto';
import { type AccessTokenPayload } from '../common/guards';
import { toUserDto } from '../common/mappers';
import { PrismaService } from '../prisma/prisma.service';
import { burnPasswordCheck, verifyPassword } from './password';

interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    @InjectEnv() private readonly env: Env,
  ) {}

  async login(req: LoginRequest, client: ClientInfo): Promise<AuthTokensDto> {
    const user = await this.prisma.user.findUnique({
      where: { email: req.email },
      include: { team: true },
    });
    const ok = user
      ? await verifyPassword(user.passwordHash, req.password)
      : (await burnPasswordCheck(req.password), false);
    if (!user || !ok || !user.isActive) {
      await this.audit.log({
        action: AuditAction.LOGIN_FAILED,
        userId: user?.id ?? null,
        metadata: {
          email: req.email,
          reason: !user ? 'unknown_email' : !ok ? 'bad_password' : 'inactive',
        },
        ip: client.ip,
      });
      // Same message for every failure: no account enumeration.
      throw new UnauthorizedException('Invalid email or password');
    }
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
      include: { team: true },
    });
    const tokens = await this.issue(updated.id, updated.role, randomUUID(), client);
    await this.audit.log({
      action: AuditAction.LOGIN,
      userId: user.id,
      ip: client.ip,
      metadata: { userAgent: client.userAgent },
    });
    return { ...tokens, user: toUserDto(updated) };
  }

  /** Rotate a refresh token. Reusing an already-rotated token revokes the entire family. */
  async refresh(presented: string, client: ClientInfo): Promise<AuthTokensDto> {
    const [id, secret] = presented.split('.', 2);
    if (!id || !secret || !/^[0-9a-f-]{36}$/.test(id)) throw new UnauthorizedException();
    const row = await this.prisma.refreshToken.findUnique({ where: { id } });
    if (!row || !safeEqualHex(row.tokenHash, sha256Hex(secret))) throw new UnauthorizedException();

    if (row.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: row.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.log({
        action: AuditAction.REFRESH_REUSE,
        userId: row.userId,
        ip: client.ip,
        metadata: { familyId: row.familyId },
      });
      throw new UnauthorizedException('Session revoked');
    }
    if (row.expiresAt < new Date()) throw new UnauthorizedException('Session expired');

    const user = await this.prisma.user.findUnique({
      where: { id: row.userId },
      include: { team: true },
    });
    if (!user || !user.isActive) throw new UnauthorizedException();

    const tokens = await this.issue(user.id, user.role, row.familyId, client);
    // Conditional update guards against two concurrent refreshes of the same token.
    const res = await this.prisma.refreshToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: new Date(), replacedById: tokens.refreshTokenId },
    });
    if (res.count !== 1) {
      await this.prisma.refreshToken.update({
        where: { id: tokens.refreshTokenId },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Session revoked');
    }
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      user: toUserDto(user),
    };
  }

  async logout(presented: string | undefined, userId: string, ip: string | null): Promise<void> {
    const id = presented?.split('.', 1)[0];
    if (id && /^[0-9a-f-]{36}$/.test(id)) {
      const row = await this.prisma.refreshToken.findUnique({ where: { id } });
      if (row && row.userId === userId) {
        await this.prisma.refreshToken.updateMany({
          where: { familyId: row.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
    }
    await this.audit.log({ action: AuditAction.LOGOUT, userId, ip });
  }

  private async issue(
    userId: string,
    role: AccessTokenPayload['role'],
    familyId: string,
    client: ClientInfo,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    refreshTokenId: string;
    expiresIn: number;
  }> {
    const payload: AccessTokenPayload = { sub: userId, typ: 'access', role };
    const accessToken = await this.jwt.signAsync(payload, {
      expiresIn: this.env.JWT_ACCESS_TTL_SEC,
    });
    const secret = randomToken(32);
    const row = await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: sha256Hex(secret),
        expiresAt: new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
        ip: client.ip,
        userAgent: client.userAgent?.slice(0, 255) ?? null,
      },
    });
    return {
      accessToken,
      refreshToken: `${row.id}.${secret}`,
      refreshTokenId: row.id,
      expiresIn: this.env.JWT_ACCESS_TTL_SEC,
    };
  }
}
