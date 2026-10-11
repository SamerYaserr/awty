import { Inject, Injectable } from '@nestjs/common';
import type PgBoss from 'pg-boss';

import { chunk } from '../common/chunk';
import type { FetchedJob, JobRef, JobSource } from '../worker/job-source';
import { PG_BOSS, QUEUES, type TaskJobData } from './queue.constants';

interface CommandResult {
  affected?: number;
  settled?: string[];
}

const MAX_JOBS_PER_COMMAND = 500;

@Injectable()
export class PgBossJobSource implements JobSource {
  constructor(@Inject(PG_BOSS) private readonly boss: PgBoss) {}

  async fetch(batchSize: number): Promise<FetchedJob[]> {
    const jobs = await this.boss.fetch<TaskJobData>(QUEUES.process, {
      batchSize,
      includeMetadata: true,
    });
    return jobs.map((job) => ({
      id: job.id,
      retryCount: job.retryCount,
      data: job.data,
    }));
  }

  async complete(job: JobRef): Promise<boolean> {
    const result = (await this.boss.complete(
      QUEUES.process,
      job.id,
    )) as unknown as CommandResult;
    return (result.affected ?? 0) > 0;
  }

  async fail(jobs: readonly JobRef[], reason: string): Promise<void> {
    const failBatch = this.boss.fail.bind(this.boss) as (
      name: string,
      ids: string[],
      data: object,
    ) => Promise<void>;
    for (const part of chunk(jobs, MAX_JOBS_PER_COMMAND)) {
      await failBatch(
        QUEUES.process,
        part.map((j) => j.id),
        { message: reason },
      );
    }
  }

  async touch(jobs: readonly JobRef[]): Promise<Set<string> | null> {
    const db = this.boss.getDb();
    const schema = (db as unknown as { config: { schema: string } }).config
      .schema;
    const refreshed = new Set<string>();

    for (const part of chunk(jobs, MAX_JOBS_PER_COMMAND)) {
      const ids = part.map((j) => j.id);
      const result = await db.executeSql(
        `UPDATE ${schema}.job
            SET started_on = now()
          WHERE name = $1
            AND id IN (SELECT UNNEST($2::uuid[]))
            AND state = 'active'
          RETURNING id`,
        [QUEUES.process, ids],
      );
      for (const row of result.rows as { id: string }[]) {
        refreshed.add(row.id);
      }
    }
    return refreshed;
  }
}
