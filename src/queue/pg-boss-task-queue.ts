import { Inject, Injectable } from '@nestjs/common';
import PgBoss, { type Db } from 'pg-boss';

import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import type { TaskQueue } from '../tasks/task-queue';
import { jobOptionsFor } from './job-options';
import { PG_BOSS, QUEUES, type TaskJobData } from './queue.constants';

@Injectable()
export class PgBossTaskQueue implements TaskQueue {
  constructor(
    @Inject(PG_BOSS) private readonly boss: PgBoss,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async enqueue(
    job: { taskId: string; durationSeconds: number },
    db: Db,
  ): Promise<void> {
    const data: TaskJobData = { taskId: job.taskId };
    const jobId = await this.boss.send(QUEUES.process, data, {
      id: job.taskId,
      db,
      ...jobOptionsFor(job.durationSeconds, this.config.tasks),
    });
    if (jobId === null) {
      throw new Error(
        `The queue did not accept the job for task ${job.taskId}`,
      );
    }
  }
}
