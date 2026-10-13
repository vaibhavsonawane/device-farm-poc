import {
  BadGatewayException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  type AppActionRequest,
  type AppInfo,
  type BuildDto,
  type InstallRequest,
  Permission,
  appActionSchema,
  installRequestSchema,
} from '@devicelab/shared-types';
import { type Response } from 'express';
import { diskStorage } from 'multer';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { AuditAction, AuditService } from '../audit/audit.service';
import {
  AgentAuth,
  type AuthUser,
  ClientIp,
  CurrentUser,
  Permissions,
} from '../common/auth.decorators';
import { sendDownload } from '../common/download';
import { ApiZodBody, ZodPipe } from '../common/zod';
import { loadEnv } from '../config/env';
import { DevicesService } from '../devices/devices.service';
import { AgentRegistry } from '../realtime/realtime.services';
import { ReservationsService } from '../reservations/reservations.service';
import { BuildsService, type UploadedBuildFile } from './builds.service';

const uploadMetaSchema = z.object({
  projectId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  releaseNotes: z.string().max(4000).optional(),
});

// Read once at module load: Multer options are static decorator arguments.
const uploadLimitBytes = (() => {
  try {
    return loadEnv().UPLOAD_MAX_MB * 1024 * 1024;
  } catch {
    return 500 * 1024 * 1024;
  }
})();

@ApiTags('builds')
@ApiBearerAuth()
@Controller('builds')
export class BuildsController {
  constructor(private readonly builds: BuildsService) {}

  @Get()
  @Permissions(Permission.BUILD_READ)
  @ApiQuery({ name: 'projectId', required: false })
  list(
    @CurrentUser() user: AuthUser,
    @Query('projectId', new ZodPipe(z.string().uuid().optional())) projectId?: string,
  ): Promise<BuildDto[]> {
    return this.builds.list(user, projectId);
  }

  @Post()
  @Permissions(Permission.BUILD_UPLOAD)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        projectId: { type: 'string' },
        releaseNotes: { type: 'string' },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({ destination: tmpdir() }),
      limits: { fileSize: uploadLimitBytes, files: 1 },
    }),
  )
  upload(
    @UploadedFile() file: UploadedBuildFile | undefined,
    @Body(new ZodPipe(uploadMetaSchema)) body: z.infer<typeof uploadMetaSchema>,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string | null,
  ): Promise<BuildDto> {
    return this.builds.upload(user, file, body, ip);
  }

  @Get(':id/download')
  @Permissions(Permission.BUILD_READ)
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string | null,
    @Res() res: Response,
  ): Promise<void> {
    sendDownload(res, await this.builds.openForUser(user, id, ip));
  }

  /** Install a build on one or more devices you currently hold. */
  @Post('install')
  @Permissions(Permission.BUILD_INSTALL)
  @ApiZodBody(installRequestSchema)
  install(
    @Body(new ZodPipe(installRequestSchema)) body: InstallRequest,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string | null,
  ): Promise<{ jobs: { jobId: string; deviceId: string }[] }> {
    return this.builds.install(user, body, ip);
  }
}

/** Host-agent facing endpoints (Authorization: Agent <token>). */
@ApiTags('agent')
@Controller('agent')
export class AgentBuildsController {
  constructor(private readonly builds: BuildsService) {}

  @Get('builds/:id/file')
  @AgentAuth()
  async file(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    sendDownload(res, await this.builds.openForAgent(id));
  }
}

/** Installed apps on a device you hold. */
@ApiTags('devices')
@ApiBearerAuth()
@Controller('devices/:id/apps')
export class DeviceAppsController {
  constructor(
    private readonly devices: DevicesService,
    private readonly reservations: ReservationsService,
    private readonly agents: AgentRegistry,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Permissions(Permission.DEVICE_USE)
  async list(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<AppInfo[]> {
    const device = await this.devices.getForUser(user, id);
    await this.reservations.assertHolder(user, id);
    const res = await this.agents.command(
      device.hostId,
      'device:apps',
      { serial: device.udid },
      20_000,
    );
    if (!res.ok) throw new BadGatewayException(res.error);
    return res.data;
  }

  @Post()
  @HttpCode(204)
  @Permissions(Permission.DEVICE_USE)
  @ApiZodBody(appActionSchema)
  async action(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(appActionSchema)) body: AppActionRequest,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string | null,
  ): Promise<void> {
    const device = await this.devices.getForUser(user, id);
    await this.reservations.assertHolder(user, id);
    const res = await this.agents.command(
      device.hostId,
      'device:app-action',
      { serial: device.udid, ...body },
      30_000,
    );
    await this.audit.log({
      action: body.action === 'uninstall' ? AuditAction.APP_UNINSTALL : AuditAction.APP_ACTION,
      userId: user.id,
      entityType: 'Device',
      entityId: id,
      metadata: { ...body, ok: res.ok },
      ip,
    });
    if (!res.ok) throw new BadGatewayException(res.error);
  }
}
