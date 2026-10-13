// DeviceLab Control Server — Crafted by Vaibhav Sonawane through Claude
import './load-env';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp, logStartup } from './bootstrap';

async function main(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });
  const env = configureApp(app);
  await app.listen(env.PORT, '0.0.0.0');
  logStartup(env);
}

void main();
