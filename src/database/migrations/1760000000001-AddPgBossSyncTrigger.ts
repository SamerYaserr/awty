import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPgBossSyncTrigger1760000000001 implements MigrationInterface {
  name = 'AddPgBossSyncTrigger1760000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION sync_task_state_from_pgboss() RETURNS TRIGGER AS $$
      DECLARE
        saved_progress INT;
      BEGIN
        IF NEW.name <> 'awty.task.process' THEN
          RETURN NEW;
        END IF;

        -- 1. Job failed after exhausting all retries
        IF NEW.state = 'failed' THEN
          UPDATE tasks
          SET status         = 'failed',
              failure_reason = 'Worker died and retries exhausted (DB trigger sync)',
              finished_at    = COALESCE(finished_at, now()),
              updated_at     = now()
          WHERE id = NEW.id
            AND status IN ('pending', 'processing')
          RETURNING progress INTO saved_progress;

          IF FOUND THEN
            PERFORM pg_notify(
              'awty_task_events',
              json_build_array(json_build_array(NEW.id, 'f', saved_progress))::text
            );
          END IF;

        -- 2. Worker died but retries remain -> reset to pending to allow a new worker to claim
        ELSIF NEW.state = 'retry' THEN
          UPDATE tasks
          SET status     = 'pending',
              worker_id  = NULL,
              updated_at = now()
          WHERE id = NEW.id
            AND status = 'processing'
          RETURNING progress INTO saved_progress;

          IF FOUND THEN
            PERFORM pg_notify(
              'awty_task_events',
              json_build_array(json_build_array(NEW.id, 'd', saved_progress))::text
            );
          END IF;
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE TRIGGER pgboss_job_sync_trigger
      AFTER INSERT OR UPDATE ON pgboss.job
      FOR EACH ROW
      WHEN (NEW.name = 'awty.task.process' AND NEW.state IN ('retry', 'failed'))
      EXECUTE FUNCTION sync_task_state_from_pgboss();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS pgboss_job_sync_trigger ON pgboss.job;`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS sync_task_state_from_pgboss;`,
    );
  }
}
