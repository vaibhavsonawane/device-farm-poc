import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ENV } from '../config/config.module';
import { type Env } from '../config/env';
import { AuthGuard, HostTokenVerifier, PermissionsGuard, UserResolver } from '../common/guards';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      global: true,
      inject: [ENV],
      useFactory: (env: Env) => ({
        secret: env.JWT_ACCESS_SECRET,
        signOptions: { issuer: 'devicelab', audience: 'devicelab-portal' },
        verifyOptions: { issuer: 'devicelab', audience: 'devicelab-portal', algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    UserResolver,
    HostTokenVerifier,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [UserResolver, HostTokenVerifier],
})
export class AuthModule {}
