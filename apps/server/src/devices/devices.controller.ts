import {
  BadGatewayException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type DeviceDto,
  Permission,
  type UpdateDeviceRequest,
  deviceQuerySchema,
  updateDeviceSchema,
} from '@devicelab/shared-types';
import { type z } from 'zod';
import { AuditAction, AuditService } from '../audit/audit.service';
import { type AuthUser, ClientIp, CurrentUser, Permissions } from '../common/auth.decorators';
import { toDeviceDto } from '../common/mappers';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../common/zod';
import { AgentRegistry } from '../realtime/realtime.services';
import { DevicesService } from './devices.service';

@ApiTags('devices')
@ApiBearerAuth()
@Controller('devices')
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly agents: AgentRegistry,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Permissions(Permission.DEVICE_READ)
  @ApiZodQuery(deviceQuerySchema)
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodPipe(deviceQuerySchema)) q: z.infer<typeof deviceQuerySchema>,
  ): Promise<DeviceDto[]> {
    return this.devices.list(user, q);
  }

  @Get(':id')
  @Permissions(Permission.DEVICE_READ)
  async get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<DeviceDto & { details: unknown }> {
    const d = await this.devices.getForUser(user, id);
    return { ...toDeviceDto(d), details: d.details };
  }

  /** Rename, tag, assign to project, maintenance mode, SIM number, notes. */
  @Patch(':id')
  @Permissions(Permission.DEVICE_ADMIN)
  @ApiZodBody(updateDeviceSchema)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateDeviceSchema)) body: UpdateDeviceRequest,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string | null,
  ): Promise<DeviceDto> {
    const dto = await this.devices.update(id, body);
    await this.audit.log({
      action: AuditAction.DEVICE_UPDATE,
      userId: user.id,
      entityType: 'Device',
      entityId: id,
      metadata: body,
      ip,
    });
    return dto;
  }

  @Post(':id/reboot')
  @HttpCode(204)
  @Permissions(Permission.DEVICE_ADMIN)
  async reboot(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string | null,
  ): Promise<void> {
    const d = await this.devices.getForUser(user, id);
    const res = await this.agents.command(d.hostId, 'device:reboot', { serial: d.udid }, 20_000);
    await this.audit.log({
      action: AuditAction.DEVICE_REBOOT,
      userId: user.id,
      entityType: 'Device',
      entityId: id,
      metadata: { ok: res.ok },
      ip,
    });
    if (!res.ok) throw new BadGatewayException(res.error);
  }

  @Delete(':id')
  @HttpCode(204)
  @Permissions(Permission.DEVICE_ADMIN)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string | null,
  ): Promise<void> {
    await this.devices.remove(id);
    await this.audit.log({
      action: AuditAction.DEVICE_REMOVE,
      userId: user.id,
      entityType: 'Device',
      entityId: id,
      ip,
    });
  }
}
