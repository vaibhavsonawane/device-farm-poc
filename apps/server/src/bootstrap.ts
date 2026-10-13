import { type INestApplication, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ATTRIBUTION } from '@devicelab/shared-types';
import helmet from 'helmet';
import type { Server as HttpServer } from 'node:http';
import type { ServerOptions } from 'socket.io';
import { ENV } from './config/config.module';
import { type Env } from './config/env';
import { StreamRelayService } from './sessions/stream-relay.service';

class DeviceLabIoAdapter extends IoAdapter {
  constructor(
    app: INestApplication,
    private readonly corsOrigins: string[],
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): unknown {
    return super.createIOServer(port, {
      ...options,
      cors: this.corsOrigins.length ? { origin: this.corsOrigins, credentials: true } : undefined,
      // Screenshots travel in agent acks.
      maxHttpBufferSize: 32 * 1024 * 1024,
      // The binary stream sockets share the HTTP server; don't let engine.io kill their upgrades.
      destroyUpgrade: false,
      pingInterval: 10_000,
      pingTimeout: 8_000,
    });
  }
}

/** Shared app setup for main.ts and the integration tests. */
export function configureApp(app: NestExpressApplication): Env {
  const env = app.get<Env>(ENV);
  app.set('trust proxy', env.TRUST_PROXY);
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  // The API serves JSON only; the portal's CSP is set by Nginx.
  app.use(
    helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }),
  );
  if (env.CORS_ORIGINS.length) app.enableCors({ origin: env.CORS_ORIGINS, credentials: true });
  app.useWebSocketAdapter(new DeviceLabIoAdapter(app, env.CORS_ORIGINS));
  app.get(StreamRelayService).attach(app.getHttpServer() as HttpServer);

  const doc = new DocumentBuilder()
    .setTitle('DeviceLab API')
    .setDescription(
      [
        'On-premises remote mobile device lab: inventory, reservations, live sessions, builds and artifacts.',
        '',
        'Authenticate with `POST /api/auth/login` and send `Authorization: Bearer <accessToken>`.',
        'Host agents use `Authorization: Agent <token>`.',
        '',
        `_${ATTRIBUTION}_`,
      ].join('\n'),
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc), {
    jsonDocumentUrl: 'api/docs-json',
  });
  return env;
}

export function logStartup(env: Env): void {
  const logger = new Logger('DeviceLab');
  logger.log(`Control server listening on :${env.PORT} (${env.NODE_ENV}) — API docs at /api/docs`);
  logger.log(ATTRIBUTION);
}
