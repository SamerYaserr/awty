import { Inject, Injectable, Logger } from '@nestjs/common';

import { isUuid } from '../common/uuid';
import type { TaskJobData } from '../queue/queue.constants';
import {
  WORKER_TASK_STORE,
  type WorkerTaskStore,
} from '../tasks/worker-task-store';

@Injectable()
export class DeadLetterHandler {
  private readonly logger = new Logger(DeadLetterHandler.name);

  constructor(
    @Inject(WORKER_TASK_STORE) private readonly store: WorkerTaskStore,
  ) {}

  async handle(jobs: ReadonlyArray<{ data: TaskJobData }>): Promise<void> {
    const taskIds = jobs
      .map((job) => job.data?.taskId)
      .filter((id): id is string => isUuid(id ?? ''));
    if (taskIds.length === 0) {
      return;
    }
    const changed = await this.store.failExhausted(
      taskIds,
      'Processing attempts exhausted without finishing the task',
    );
    this.logger.warn(
      `Marked ${changed} task(s) as failed after the queue ran out of attempts`,
    );
  }
}
