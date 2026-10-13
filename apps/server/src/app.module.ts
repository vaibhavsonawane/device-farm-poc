import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ArtifactsController } from './artifacts/artifacts.controller';
import { ArtifactsService } from './artifacts/artifacts.service';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import {
  AgentBuildsController,
  BuildsController,
  DeviceAppsController,
} from './builds/builds.controller';
import { BuildsService } from './builds/builds.service';
import { ConfigModule } from './config/config.module';
import { DevicesController } from './devices/devices.controller';
import { DevicesService } from './devices/devices.service';
import { HealthController } from './health/health.controller';
import { HostsController } from './hosts/hosts.controller';
import { HostsService } from './hosts/hosts.service';
import { OrgController } from './org/org.controller';
import { PrismaModule } from './prisma/prisma.service';
import { AgentGateway } from './realtime/agent.gateway';
import { PortalGateway } from './realtime/portal.gateway';
import { RealtimeModule } from './realtime/realtime.services';
import { RedisModule } from './redis/redis.service';
import { ReservationsController } from './reservations/reservations.controller';
import { ReservationsService } from './reservations/reservations.service';
import { SweeperService } from './reservations/sweeper.service';
import { SessionsController } from './sessions/sessions.controller';
import { SessionsService } from './sessions/sessions.service';
import { StreamRelayService } from './sessions/stream-relay.service';
import { StreamTokens } from './sessions/stream-tokens';
import { StorageModule } from './storage/storage.service';
import { UsersController } from './users/users.controller';

/**
 * Infrastructure lives in global modules (config, prisma, redis, storage, audit,
 * auth, realtime). Domain services are registered here in one module: they are
 * tightly coupled (devices ⇄ reservations ⇄ sessions ⇄ relay) and splitting
 * them would only add forwardRef noise.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RedisModule,
    StorageModule,
    AuditModule,
    AuthModule,
    RealtimeModule,
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 600 }]),
  ],
  controllers: [
    HealthController,
    UsersController,
    OrgController,
    HostsController,
    DevicesController,
    ReservationsController,
    SessionsController,
    BuildsController,
    AgentBuildsController,
    DeviceAppsController,
    ArtifactsController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    DevicesService,
    HostsService,
    ReservationsService,
    SweeperService,
    StreamTokens,
    StreamRelayService,
    SessionsService,
    ArtifactsService,
    BuildsService,
    AgentGateway,
    PortalGateway,
  ],
})
export class AppModule {}
