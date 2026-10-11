import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';

import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';

const REQUEST_ID_PATTERN = /^[\w.-]{1,100}$/;

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.log.level,
          transport: config.log.pretty
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
          genReqId: (request, response) => {
            const header = request.headers['x-request-id'];
            const id =
              typeof header === 'string' && REQUEST_ID_PATTERN.test(header)
                ? header
                : randomUUID();
            response.setHeader('x-request-id', id);
            return id;
          },
          autoLogging: {
            ignore: (request) => request.url?.startsWith('/health') ?? false,
          },
          serializers: {
            req: (request: { id: string; method: string; url: string }) => ({
              id: request.id,
              method: request.method,
              url: request.url,
            }),
            res: (response: { statusCode: number }) => ({
              statusCode: response.statusCode,
            }),
          },
        },
      }),
    }),
  ],
})
export class LoggingModule {}
