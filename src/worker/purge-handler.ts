import { Inject, Injectable, Logger } from '@nestjs/common';

import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import {
  WORKER_TASK_STORE,
  type WorkerTaskStore,
} from '../tasks/worker-task-store';

const BATCH_SIZE = 5000;
const MAX_BATCHES_PER_RUN = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class PurgeHandler {
  private readonly logger = new Logger(PurgeHandler.name);

  constructor(
    @Inject(WORKER_TASK_STORE) private readonly store: WorkerTaskStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly now: () => number = Date.now,
  ) {}

  async handle(): Promise<number> {
    const cutoff = new Date(
      this.now() - this.config.tasks.retentionDays * DAY_MS,
    );
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      const deleted = await this.store.purgeFinishedBefore(cutoff, BATCH_SIZE);
      total += deleted;
      if (deleted < BATCH_SIZE) {
        break;
      }
    }
    if (total > 0) {
      this.logger.log(
        `Purged ${total} finished task(s) older than ${this.config.tasks.retentionDays} days`,
      );
    }
    return total;
  }
}
