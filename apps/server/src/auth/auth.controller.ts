import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  type AuthTokensDto,
  type LoginRequest,
  type RefreshRequest,
  type UserDto,
  loginRequestSchema,
  refreshRequestSchema,
} from '@devicelab/shared-types';
import { type Request } from 'express';
import { z } from 'zod';
import {
  type AuthUser,
  ClientIp,
  CurrentUser,
  Permissions,
  Public,
} from '../common/auth.decorators';
import { toUserDto } from '../common/mappers';
import { ApiZodBody, ZodPipe } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

const logoutSchema = z.object({ refreshToken: z.string().max(512).optional() });

// Read at import time because @Throttle takes static options (main.ts loads .env first).
const loginLimit = Math.max(1, Number(process.env.AUTH_LOGIN_LIMIT_PER_MIN ?? 10) || 10);

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: loginLimit, ttl: 60_000 } })
  @ApiZodBody(loginRequestSchema)
  login(
    @Body(new ZodPipe(loginRequestSchema)) body: LoginRequest,
    @ClientIp() ip: string | null,
    @Req() req: Request,
  ): Promise<AuthTokensDto> {
    return this.auth.login(body, { ip, userAgent: req.headers['user-agent'] ?? null });
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiZodBody(refreshRequestSchema)
  refresh(
    @Body(new ZodPipe(refreshRequestSchema)) body: RefreshRequest,
    @ClientIp() ip: string | null,
    @Req() req: Request,
  ): Promise<AuthTokensDto> {
    return this.auth.refresh(body.refreshToken, {
      ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Post('logout')
  @HttpCode(204)
  @ApiBearerAuth()
  @Permissions()
  @ApiZodBody(logoutSchema)
  async logout(
    @Body(new ZodPipe(logoutSchema)) body: z.infer<typeof logoutSchema>,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string | null,
  ): Promise<void> {
    await this.auth.logout(body.refreshToken, user.id, ip);
  }

  @Get('me')
  @ApiBearerAuth()
  @Permissions()
  async me(@CurrentUser() user: AuthUser): Promise<UserDto> {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: { team: true },
    });
    return toUserDto(u);
  }
}
