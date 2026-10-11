import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import { chunk } from '../common/chunk';
import {
  MAX_EVENTS_PER_NOTIFICATION,
  TASK_EVENTS_CHANNEL,
} from '../events/task-event';
import { TaskEntity } from './entities/task.entity';
import type { TaskStateReader } from './task-state-reader';
import type { TaskState } from './task.types';
import type {
  ProgressUpdate,
  TaskClaim,
  WorkerTaskStore,
} from './worker-task-store';

const CLAIM_SQL = `
  UPDATE tasks
     SET status = 'processing',
         attempt = attempt + 1,
         worker_id = $2,
         started_at = COALESCE(started_at, now()),
         updated_at = now()
   WHERE id = $1 AND status IN ('pending', 'processing')
  RETURNING attempt, progress, duration_seconds AS "durationSeconds"
`;

const FLUSH_PROGRESS_SQL = `
  WITH batch AS (
    SELECT * FROM unnest($1::uuid[], $2::int[], $3::smallint[]) AS b(id, attempt, progress)
  ), updated AS (
    UPDATE tasks t
       SET progress = b.progress, updated_at = now()
      FROM batch b
     WHERE t.id = b.id
       AND t.attempt = b.attempt
       AND t.status = 'processing'
       AND t.progress <= b.progress
    RETURNING t.id, t.progress
  ), notice AS (
    SELECT pg_notify($4, json_agg(json_build_array(id, 'p', progress))::text)
      FROM updated
    HAVING count(*) > 0
  )
  SELECT updated.id FROM updated, (SELECT count(*) FROM notice) AS sent
`;

const COMPLETE_SQL = `
  WITH done AS (
    UPDATE tasks
       SET status = 'completed', progress = 100, finished_at = now(), updated_at = now()
     WHERE id = $1 AND attempt = $2 AND status = 'processing'
    RETURNING id
  )
  SELECT id, pg_notify($3, json_build_array(json_build_array(id, 'c', 100))::text) FROM done
`;

const FAIL_SQL = `
  WITH failed AS (
    UPDATE tasks
       SET status = 'failed', finished_at = now(), updated_at = now(), failure_reason = $3
     WHERE id = $1 AND attempt = $2 AND status = 'processing'
    RETURNING id, progress
  )
  SELECT id, pg_notify($4, json_build_array(json_build_array(id, 'f', progress))::text) FROM failed
`;

const FAIL_EXHAUSTED_SQL = `
  WITH failed AS (
    UPDATE tasks
       SET status = 'failed', finished_at = now(), updated_at = now(), failure_reason = $2
     WHERE id = ANY($1::uuid[]) AND status IN ('pending', 'processing')
    RETURNING id, progress
  ), notice AS (
    SELECT pg_notify($3, json_agg(json_build_array(id, 'f', progress))::text)
      FROM failed
    HAVING count(*) > 0
  )
  SELECT failed.id FROM failed, (SELECT count(*) FROM notice) AS sent
`;

const PURGE_SQL = `
  WITH doomed AS (
    SELECT id FROM tasks
     WHERE finished_at < $1
     ORDER BY finished_at
     LIMIT $2
       FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM tasks t USING doomed d WHERE t.id = d.id RETURNING t.id
  )
  SELECT count(*)::int AS deleted FROM deleted
`;

const FIND_STATES_SQL = `SELECT id, status, progress FROM tasks WHERE id = ANY($1::uuid[])`;

@Injectable()
export class TasksRepository implements TaskStateReader, WorkerTaskStore {
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

  async claim(taskId: string, workerId: string): Promise<TaskClaim | null> {
    const rows = await this.rows<TaskClaim>(CLAIM_SQL, [taskId, workerId]);
    return rows[0] ?? null;
  }

  async flushProgress(
    updates: readonly ProgressUpdate[],
  ): Promise<Set<string>> {
    const applied = new Set<string>();
    for (const part of chunk(updates, MAX_EVENTS_PER_NOTIFICATION)) {
      const rows = await this.rows<{ id: string }>(FLUSH_PROGRESS_SQL, [
        part.map((update) => update.taskId),
        part.map((update) => update.attempt),
        part.map((update) => update.progress),
        TASK_EVENTS_CHANNEL,
      ]);
      for (const row of rows) {
        applied.add(row.id);
      }
    }
    return applied;
  }

  async complete(taskId: string, attempt: number): Promise<boolean> {
    const rows = await this.rows(COMPLETE_SQL, [
      taskId,
      attempt,
      TASK_EVENTS_CHANNEL,
    ]);
    return rows.length > 0;
  }

  async fail(
    taskId: string,
    attempt: number,
    reason: string,
  ): Promise<boolean> {
    const rows = await this.rows(FAIL_SQL, [
      taskId,
      attempt,
      reason,
      TASK_EVENTS_CHANNEL,
    ]);
    return rows.length > 0;
  }

  async failExhausted(
    taskIds: readonly string[],
    reason: string,
  ): Promise<number> {
    let changed = 0;
    for (const part of chunk(taskIds, MAX_EVENTS_PER_NOTIFICATION)) {
      const rows = await this.rows(FAIL_EXHAUSTED_SQL, [
        part,
        reason,
        TASK_EVENTS_CHANNEL,
      ]);
      changed += rows.length;
    }
    return changed;
  }

  async purgeFinishedBefore(cutoff: Date, limit: number): Promise<number> {
    const rows = await this.rows<{ deleted: number }>(PURGE_SQL, [
      cutoff,
      limit,
    ]);
    return rows[0]?.deleted ?? 0;
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
