import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { AppConfig, loadDotEnvIfPresent } from './config/app-config';
import { APP_CONFIG } from './config/config.module';

loadDotEnvIfPresent();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const config = app.get<AppConfig>(APP_CONFIG);

  await app.listen(config.http.port, config.http.host);
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
