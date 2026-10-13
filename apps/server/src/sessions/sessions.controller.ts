import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type ArtifactDto,
  type CreateSessionRequest,
  Permission,
  type SessionDto,
  type SessionJoinDto,
  type StreamQuality,
  createSessionSchema,
  streamQualitySchema,
} from '@devicelab/shared-types';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { type AuthUser, ClientIp, CurrentUser, Permissions } from '../common/auth.decorators';
import { ApiZodBody, ZodPipe } from '../common/zod';
import { SessionsService } from './sessions.service';

@ApiTags('sessions')
@ApiBearerAuth()
@Controller('sessions')
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly artifacts: ArtifactsService,
  ) {}

  @Get('active')
  @Permissions(Permission.DEVICE_OBSERVE)
  listActive(): ReturnType<SessionsService['listActive']> {
    return this.sessions.listActive();
  }

  /** Open (or rejoin) the live session for your reservation. Returns a stream ticket. */
  @Post()
  @Permissions(Permission.DEVICE_USE)
  @ApiZodBody(createSessionSchema)
  start(
    @Body(new ZodPipe(createSessionSchema)) body: CreateSessionRequest,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string | null,
  ): Promise<SessionJoinDto> {
    return this.sessions.start(user, body, ip);
  }

  /** Fresh stream ticket for an existing session (controller if you hold it, else observer). */
  @Post(':id/ticket')
  @Permissions(Permission.DEVICE_READ)
  ticket(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string | null,
  ): Promise<SessionJoinDto> {
    return this.sessions.observe(user, id, ip);
  }

  @Post(':id/end')
  @Permissions(Permission.DEVICE_USE)
  end(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string | null,
  ): Promise<SessionDto> {
    return this.sessions.end(user, id, ip);
  }

  @Post(':id/quality')
  @HttpCode(204)
  @Permissions(Permission.DEVICE_USE)
  @ApiZodBody(streamQualitySchema)
  async quality(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(streamQualitySchema)) body: StreamQuality,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.sessions.setQuality(user, id, body);
  }

  /** Capture a screenshot; stored as an artifact. */
  @Post(':id/screenshot')
  @Permissions(Permission.DEVICE_USE)
  async screenshot(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string | null,
  ): Promise<ArtifactDto> {
    const access = await this.sessions.access(user, id);
    if (access.role !== 'controller')
      throw new ForbiddenException('Only the device holder can take screenshots');
    return this.artifacts.captureScreenshot(user, access, ip);
  }
}
