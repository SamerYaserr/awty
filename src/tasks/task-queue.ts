import type { Db } from 'pg-boss';

export interface TaskQueue {
  enqueue(
    job: { taskId: string; durationSeconds: number },
    db: Db,
  ): Promise<void>;
}

export const TASK_QUEUE = Symbol('TASK_QUEUE');
