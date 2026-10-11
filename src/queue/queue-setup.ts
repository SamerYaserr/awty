import type PgBoss from 'pg-boss';

import type { AppConfig } from '../config/app-config';
import { QUEUES } from './queue.constants';

export async function ensureQueues(
  boss: PgBoss,
  config: AppConfig,
): Promise<void> {
  const dead: PgBoss.Queue = {
    name: QUEUES.dead,
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
    retentionSeconds: 24 * 3600,
  };
  const purge: PgBoss.Queue = {
    name: QUEUES.purge,
    retryLimit: 1,
    expireInSeconds: 600,
    retentionSeconds: 3600,
  };
  const process: PgBoss.Queue = {
    name: QUEUES.process,
    retryLimit: config.tasks.maxAttempts - 1,
    retryDelay: 2,
    retryBackoff: true,
    retentionSeconds: 3600,
  };

  await boss.createQueue(QUEUES.dead, dead);
  await boss.createQueue(QUEUES.purge, purge);
  await boss.createQueue(QUEUES.process, {
    ...process,
    deadLetter: QUEUES.dead,
    policy: 'stately',
  });

  await boss.updateQueue(QUEUES.dead, dead);
  await boss.updateQueue(QUEUES.purge, purge);
  await boss.updateQueue(QUEUES.process, {
    ...process,
    deadLetter: QUEUES.dead,
  });
}
