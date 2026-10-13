import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  type ProjectDto,
  type PublicSettingsDto,
  type TeamDto,
} from '@devicelab/shared-types';
import { z } from 'zod';
import { AuditAction, AuditService } from '../audit/audit.service';
import { type AuthUser, ClientIp, CurrentUser, Permissions } from '../common/auth.decorators';
import { InjectEnv } from '../config/config.module';
import { type Env } from '../config/env';
import { toProjectDto } from '../common/mappers';
import { ApiZodBody, ZodPipe } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';

const createTeamSchema = z.object({ name: z.string().trim().min(1).max(80) });
const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  code: z
    .string()
    .trim()
    .min(2)
    .max(16)
    .regex(/^[A-Z0-9_-]+$/, 'Upper-case letters, digits, - and _'),
  teamId: z.string().uuid().nullable().optional(),
});

@ApiTags('org')
@ApiBearerAuth()
@Controller()
export class OrgController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @InjectEnv() private readonly env: Env,
  ) {}

  @Get('teams')
  @Permissions()
  async teams(): Promise<TeamDto[]> {
    return this.prisma.team.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
  }

  @Post('teams')
  @Permissions(Permission.USER_ADMIN)
  @ApiZodBody(createTeamSchema)
  async createTeam(
    @Body(new ZodPipe(createTeamSchema)) body: z.infer<typeof createTeamSchema>,
    @CurrentUser() actor: AuthUser,
    @ClientIp() ip: string | null,
  ): Promise<TeamDto> {
    const team = await this.prisma.team.create({ data: { name: body.name } });
    await this.audit.log({
      action: AuditAction.ORG_CHANGE,
      userId: actor.id,
      entityType: 'Team',
      entityId: team.id,
      metadata: body,
      ip,
    });
    return { id: team.id, name: team.name };
  }

  @Get('projects')
  @Permissions()
  async projects(): Promise<ProjectDto[]> {
    const rows = await this.prisma.project.findMany({ orderBy: { name: 'asc' } });
    return rows.map(toProjectDto);
  }

  @Post('projects')
  @Permissions(Permission.USER_ADMIN)
  @ApiZodBody(createProjectSchema)
  async createProject(
    @Body(new ZodPipe(createProjectSchema)) body: z.infer<typeof createProjectSchema>,
    @CurrentUser() actor: AuthUser,
    @ClientIp() ip: string | null,
  ): Promise<ProjectDto> {
    const p = await this.prisma.project.create({
      data: { name: body.name, code: body.code, teamId: body.teamId ?? null },
    });
    await this.audit.log({
      action: AuditAction.ORG_CHANGE,
      userId: actor.id,
      entityType: 'Project',
      entityId: p.id,
      metadata: body,
      ip,
    });
    return toProjectDto(p);
  }

  @Get('settings/public')
  @Permissions()
  settings(): PublicSettingsDto {
    return {
      defaultReservationMinutes: this.env.RESERVATION_DEFAULT_MIN,
      maxReservationMinutes: this.env.RESERVATION_MAX_MIN,
      idleWarnMinutes: this.env.IDLE_WARN_MIN,
      idleReleaseMinutes: this.env.IDLE_RELEASE_MIN,
    };
  }
}
