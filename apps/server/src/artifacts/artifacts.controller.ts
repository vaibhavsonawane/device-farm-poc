import { Controller, Get, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { type ArtifactDto, Permission } from '@devicelab/shared-types';
import { type Response } from 'express';
import { z } from 'zod';
import { type AuthUser, ClientIp, CurrentUser, Permissions } from '../common/auth.decorators';
import { sendDownload } from '../common/download';
import { ZodPipe } from '../common/zod';
import { ArtifactsService } from './artifacts.service';

@ApiTags('artifacts')
@ApiBearerAuth()
@Controller('artifacts')
export class ArtifactsController {
  constructor(private readonly artifacts: ArtifactsService) {}

  @Get()
  @Permissions(Permission.ARTIFACT_READ)
  @ApiQuery({ name: 'sessionId', required: false })
  list(
    @CurrentUser() user: AuthUser,
    @Query('sessionId', new ZodPipe(z.string().uuid().optional())) sessionId?: string,
  ): Promise<ArtifactDto[]> {
    return sessionId
      ? this.artifacts.listForSession(user, sessionId)
      : this.artifacts.listMine(user);
  }

  @Get(':id/download')
  @Permissions(Permission.ARTIFACT_READ)
  @ApiQuery({ name: 'inline', required: false, type: Boolean })
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('inline') inline: string | undefined,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string | null,
    @Res() res: Response,
  ): Promise<void> {
    sendDownload(res, await this.artifacts.open(user, id, ip), inline === 'true');
  }
}
