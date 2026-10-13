import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  type CreateReservationRequest,
  type ExtendReservationRequest,
  Permission,
  type ReservationDto,
  createReservationSchema,
  extendReservationSchema,
} from '@devicelab/shared-types';
import { z } from 'zod';
import { type AuthUser, ClientIp, CurrentUser, Permissions } from '../common/auth.decorators';
import { ApiZodBody, ZodPipe } from '../common/zod';
import { ReservationsService } from './reservations.service';

const scopeSchema = z.enum(['mine', 'active-all']).default('mine');

@ApiTags('reservations')
@ApiBearerAuth()
@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Get()
  @Permissions(Permission.DEVICE_READ)
  @ApiQuery({ name: 'scope', required: false, enum: ['mine', 'active-all'] })
  list(
    @CurrentUser() user: AuthUser,
    @Query('scope', new ZodPipe(scopeSchema)) scope: 'mine' | 'active-all',
  ): Promise<ReservationDto[]> {
    return this.reservations.listForUser(user, scope);
  }

  /** "Use now": reserve an available device immediately. */
  @Post()
  @Permissions(Permission.DEVICE_USE)
  @ApiZodBody(createReservationSchema)
  create(
    @Body(new ZodPipe(createReservationSchema)) body: CreateReservationRequest,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string | null,
  ): Promise<ReservationDto> {
    return this.reservations.create(user, body, ip);
  }

  @Get(':id')
  @Permissions(Permission.DEVICE_READ)
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ReservationDto> {
    return this.reservations.get(user, id);
  }

  @Post(':id/extend')
  @Permissions(Permission.DEVICE_USE)
  @ApiZodBody(extendReservationSchema)
  extend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(extendReservationSchema)) body: ExtendReservationRequest,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string | null,
  ): Promise<ReservationDto> {
    return this.reservations.extend(user, id, body.minutes, ip);
  }

  /** "I'm still here" — resets the idle timer. */
  @Post(':id/keepalive')
  @Permissions(Permission.DEVICE_USE)
  async keepalive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ ok: true }> {
    await this.reservations.getOwnActive(user, id);
    await this.reservations.touch(id, true);
    return { ok: true };
  }

  /** Release your own reservation, or force-release someone else's (LEAD/ADMIN). */
  @Post(':id/release')
  @Permissions(Permission.DEVICE_USE)
  release(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string | null,
  ): Promise<ReservationDto> {
    return this.reservations.releaseByUser(user, id, ip);
  }
}
