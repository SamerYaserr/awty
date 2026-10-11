import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import { TaskEntity } from './entities/task.entity';
import type { TaskStateReader } from './task-state-reader';
import type { TaskState } from './task.types';

const FIND_STATES_SQL = `SELECT id, status, progress FROM tasks WHERE id = ANY($1::uuid[])`;

@Injectable()
export class TasksRepository implements TaskStateReader {
  constructor(private readonly dataSource: DataSource) {}

  async insertPending(
    manager: EntityManager,
    task: { id: string; durationSeconds: number },
  ): Promise<void> {
    await manager.insert(TaskEntity, {
      id: task.id,
      durationSeconds: task.durationSeconds,
    });
  }

  async findState(id: string): Promise<TaskState | null> {
    const row = await this.dataSource.getRepository(TaskEntity).findOne({
      where: { id },
      select: { id: true, status: true, progress: true },
    });
    return row
      ? { id: row.id, status: row.status, progress: row.progress }
      : null;
  }

  async findStates(ids: readonly string[]): Promise<TaskState[]> {
    if (ids.length === 0) {
      return [];
    }
    return this.rows<TaskState>(FIND_STATES_SQL, [ids]);
  }

  private async rows<T = unknown>(
    sql: string,
    parameters: unknown[],
  ): Promise<T[]> {
    const runner = this.dataSource.createQueryRunner();
    try {
      const result = await runner.query(sql, parameters, true);
      return result.records as T[];
    } finally {
      await runner.release();
    }
  }
}
