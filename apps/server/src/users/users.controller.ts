import {
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import {
  type CreateUserRequest,
  Permission,
  type UpdateUserRequest,
  type UserDto,
  createUserSchema,
  updateUserSchema,
} from '@devicelab/shared-types';
import { AuditAction, AuditService } from '../audit/audit.service';
import { type AuthUser, ClientIp, CurrentUser, Permissions } from '../common/auth.decorators';
import { toUserDto } from '../common/mappers';
import { ApiZodBody, ZodPipe } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword } from '../auth/password';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Permissions(Permission.USER_ADMIN)
  async list(): Promise<UserDto[]> {
    const users = await this.prisma.user.findMany({
      orderBy: { name: 'asc' },
      include: { team: true },
    });
    return users.map(toUserDto);
  }

  @Post()
  @Permissions(Permission.USER_ADMIN)
  @ApiZodBody(createUserSchema)
  async create(
    @Body(new ZodPipe(createUserSchema)) body: CreateUserRequest,
    @CurrentUser() actor: AuthUser,
    @ClientIp() ip: string | null,
  ): Promise<UserDto> {
    try {
      const user = await this.prisma.user.create({
        data: {
          name: body.name,
          email: body.email,
          role: body.role,
          teamId: body.teamId ?? null,
          passwordHash: await hashPassword(body.password),
        },
        include: { team: true },
      });
      await this.audit.log({
        action: AuditAction.USER_CREATE,
        userId: actor.id,
        entityType: 'User',
        entityId: user.id,
        metadata: { email: user.email, role: user.role },
        ip,
      });
      return toUserDto(user);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('A user with this email already exists');
      }
      throw e;
    }
  }

  @Patch(':id')
  @Permissions(Permission.USER_ADMIN)
  @ApiZodBody(updateUserSchema)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateUserSchema)) body: UpdateUserRequest,
    @CurrentUser() actor: AuthUser,
    @ClientIp() ip: string | null,
  ): Promise<UserDto> {
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException();
    if (
      id === actor.id &&
      (body.isActive === false || (body.role && body.role !== existing.role))
    ) {
      throw new ConflictException('You cannot deactivate yourself or change your own role');
    }
    const user = await this.prisma.user.update({
      where: { id },
      data: {
        name: body.name,
        role: body.role,
        teamId: body.teamId,
        isActive: body.isActive,
        passwordHash: body.password ? await hashPassword(body.password) : undefined,
      },
      include: { team: true },
    });
    if (body.isActive === false || body.password) {
      // Kill existing sessions when deactivating or resetting a password.
      await this.prisma.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    const { password: _pw, ...changes } = body;
    await this.audit.log({
      action: AuditAction.USER_UPDATE,
      userId: actor.id,
      entityType: 'User',
      entityId: id,
      metadata: { changes, passwordReset: Boolean(body.password) },
      ip,
    });
    return toUserDto(user);
  }
}
