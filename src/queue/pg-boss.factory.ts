import { Logger } from '@nestjs/common';
import PgBoss, { type ConstructorOptions } from 'pg-boss';

import type { AppConfig } from '../config/app-config';

export type QueueRole = 'api' | 'worker' | 'migrate';

export function createBoss(config: AppConfig, role: QueueRole): PgBoss {
  const options: ConstructorOptions = {
    connectionString: config.db.url,
    ssl: config.db.ssl || undefined,
    schema: config.queue.schema,
    max: config.queue.poolMax,
    application_name: `awty-${role}-queue`,
    migrate: role === 'migrate',
    supervise: role === 'worker',
    schedule: role === 'worker',
    monitorStateIntervalSeconds: 10,
    maintenanceIntervalSeconds: 300,
  };
  const boss = new PgBoss(options);
  const logger = new Logger(`PgBoss:${role}`);
  boss.on('error', (error) =>
    logger.error(`pg-boss error: ${error.message}`, error.stack),
  );
  return boss;
}

export async function startBoss(
  config: AppConfig,
  role: QueueRole,
): Promise<PgBoss> {
  const boss = createBoss(config, role);
  await boss.start();
  return boss;
}
