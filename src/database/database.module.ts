import { DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/app-config';
import { createDataSourceOptions } from './data-source-options';

@Module({})
export class DatabaseModule {
  static forRole(role: 'api' | 'worker'): DynamicModule {
    return {
      module: DatabaseModule,
      imports: [
        TypeOrmModule.forRootAsync({
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig) =>
            createDataSourceOptions(config, `awty-${role}`),
        }),
      ],
    };
  }
}
