import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { isUuid } from '../common/uuid';
import { pgBossDbFor } from '../queue/typeorm-db';
import { TASK_QUEUE, type TaskQueue } from './task-queue';
import type { TaskState } from './task.types';
import { TasksRepository } from './tasks.repository';

@Injectable()
export class TasksService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly repository: TasksRepository,
    @Inject(TASK_QUEUE) private readonly queue: TaskQueue,
  ) {}

  async create(
    durationSeconds: number,
  ): Promise<{ id: string; status: 'pending' }> {
    const id = randomUUID();
    await this.dataSource.transaction(async (manager) => {
      await this.repository.insertPending(manager, { id, durationSeconds });
      await this.queue.enqueue(
        { taskId: id, durationSeconds },
        pgBossDbFor(manager),
      );
    });
    return { id, status: 'pending' };
  }

  async get(id: string): Promise<TaskState> {
    const state = isUuid(id) ? await this.repository.findState(id) : null;
    if (!state) {
      throw new NotFoundException(`Task ${id} not found`);
    }
    return state;
  }
}
