import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type PgBoss from 'pg-boss';

import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { PG_BOSS, QUEUES, type TaskJobData } from '../queue/queue.constants';
import { DeadLetterHandler } from './dead-letter-handler';
import { ProgressReporter } from './progress-reporter';
import { PurgeHandler } from './purge-handler';
import { TaskConsumer } from './task-consumer';

const PURGE_CRON = '*/10 * * * *';

@Injectable()
export class WorkerLifecycle
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(WorkerLifecycle.name);

  constructor(
    private readonly reporter: ProgressReporter,
    private readonly consumer: TaskConsumer,
    private readonly deadLetter: DeadLetterHandler,
    private readonly purge: PurgeHandler,
    @Inject(PG_BOSS) private readonly boss: PgBoss,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.reporter.start();
    this.consumer.start();

    await this.boss.work<TaskJobData>(
      QUEUES.dead,
      { batchSize: 25, pollingIntervalSeconds: 2 },
      (jobs) => this.deadLetter.handle(jobs),
    );
    await this.boss.work(
      QUEUES.purge,
      { pollingIntervalSeconds: 30 },
      async () => {
        await this.purge.handle();
      },
    );
    await this.boss.schedule(QUEUES.purge, PURGE_CRON);

    this.logger.log(
      `Worker ready: up to ${this.config.worker.concurrency} concurrent tasks, ` +
        `heartbeat window ${this.config.tasks.heartbeatSeconds}s`,
    );
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`Shutting down${signal ? ` on ${signal}` : ''}`);

    await this.consumer.stop();
    await this.reporter.stop();
    await this.boss.stop({
      graceful: true,
      timeout: this.config.worker.shutdownTimeoutMs,
    });
  }
}
