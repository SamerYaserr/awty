import 'reflect-metadata';
import { DataSource } from 'typeorm';

import { loadConfig, loadDotEnvIfPresent } from './config/app-config';
import { createDataSourceOptions } from './database/data-source-options';
import { createBoss } from './queue/pg-boss.factory';
import { ensureQueues } from './queue/queue-setup';

const MIGRATION_LOCK_KEY = 7_243_001;

async function main(): Promise<void> {
  loadDotEnvIfPresent();
  const config = loadConfig();

  const dataSource = new DataSource(
    createDataSourceOptions(config, 'awty-migrate', 2),
  );
  await dataSource.initialize();
  const lock = dataSource.createQueryRunner();
  await lock.connect();

  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    const boss = createBoss(config, 'migrate');
    await boss.start();
    try {
      await ensureQueues(boss, config);
      console.log('Queues are ready');
    } finally {
      await boss.stop({ graceful: false, timeout: 5000 });
    }

    const applied = await dataSource.runMigrations({ transaction: 'each' });
    console.log(
      applied.length > 0
        ? `Applied migrations: ${applied.map((migration) => migration.name).join(', ')}`
        : 'Database schema is up to date',
    );
  } finally {
    await lock
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    await lock.release();
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
