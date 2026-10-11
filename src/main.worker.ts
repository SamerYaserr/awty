import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { loadDotEnvIfPresent } from './config/app-config';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  loadDotEnvIfPresent();

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
