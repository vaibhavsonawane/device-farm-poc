import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type CreateHostRequest,
  type HostDto,
  type HostTokenDto,
  Permission,
  createHostSchema,
} from '@devicelab/shared-types';
import { type AuthUser, ClientIp, CurrentUser, Permissions } from '../common/auth.decorators';
import { ApiZodBody, ZodPipe } from '../common/zod';
import { HostsService } from './hosts.service';

@ApiTags('hosts')
@ApiBearerAuth()
@Controller('hosts')
export class HostsController {
  constructor(private readonly hosts: HostsService) {}

  @Get()
  @Permissions(Permission.DEVICE_READ)
  list(): Promise<HostDto[]> {
    return this.hosts.list();
  }

  /** Register a host. The agent token is returned once — copy it into agent.config.json. */
  @Post()
  @Permissions(Permission.HOST_ADMIN)
  @ApiZodBody(createHostSchema)
  create(
    @Body(new ZodPipe(createHostSchema)) body: CreateHostRequest,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string | null,
  ): Promise<HostTokenDto> {
    return this.hosts.create(body.name, user.id, ip);
  }

  @Post(':id/rotate-token')
  @Permissions(Permission.HOST_ADMIN)
  rotate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string | null,
  ): Promise<HostTokenDto> {
    return this.hosts.rotateToken(id, user.id, ip);
  }

  @Post(':id/revoke')
  @Permissions(Permission.HOST_ADMIN)
  revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string | null,
  ): Promise<HostDto> {
    return this.hosts.revoke(id, user.id, ip);
  }

  @Post(':id/resync')
  @HttpCode(204)
  @Permissions(Permission.HOST_ADMIN)
  async resync(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string | null,
  ): Promise<void> {
    await this.hosts.resync(id, user.id, ip);
  }
}
