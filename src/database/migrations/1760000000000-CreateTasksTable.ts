import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateTasksTable1760000000000 implements MigrationInterface {
  name = 'CreateTasksTable1760000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE tasks (
        id               uuid        PRIMARY KEY,
        status           text        NOT NULL DEFAULT 'pending',
        duration_seconds integer     NOT NULL,
        progress         smallint    NOT NULL DEFAULT 0,
        attempt          integer     NOT NULL DEFAULT 0,
        worker_id        text,
        failure_reason   text,
        created_at       timestamptz NOT NULL DEFAULT now(),
        started_at       timestamptz,
        finished_at      timestamptz,
        updated_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT tasks_status_check
          CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
        CONSTRAINT tasks_duration_check
          CHECK (duration_seconds BETWEEN 1 AND 86400),
        CONSTRAINT tasks_progress_check
          CHECK (progress BETWEEN 0 AND 100),
        CONSTRAINT tasks_completed_progress_check
          CHECK (status <> 'completed' OR progress = 100)
      ) WITH (fillfactor = 70)
    `);

    await queryRunner.query(`
      CREATE INDEX tasks_finished_at_idx ON tasks (finished_at) WHERE finished_at IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX tasks_finished_at_idx');
    await queryRunner.query('DROP TABLE tasks');
  }
}
