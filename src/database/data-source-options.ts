import type { DataSourceOptions } from 'typeorm';

import type { AppConfig } from '../config/app-config';
import { TaskEntity } from '../tasks/entities/task.entity';
import { CreateTasksTable1760000000000 } from './migrations/1760000000000-CreateTasksTable';

export function createDataSourceOptions(
  config: AppConfig,
  applicationName: string,
  poolSize: number = config.db.poolMax,
): DataSourceOptions {
  return {
    type: 'postgres',
    url: config.db.url,
    ssl: config.db.ssl || undefined,
    applicationName,
    entities: [TaskEntity],
    migrations: [CreateTasksTable1760000000000],
    migrationsTableName: 'typeorm_migrations',
    synchronize: false,
    migrationsRun: false,
    poolSize,
    logging: ['error'],
    extra: {
      statement_timeout: 15_000,
      idle_in_transaction_session_timeout: 30_000,
      connectionTimeoutMillis: 5_000,
      keepAlive: true,
    },
  };
}
