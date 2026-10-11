import { hostname } from 'node:os';
import { Module } from '@nestjs/common';

import { systemClock } from '../common/clock';
import { MAX_EVENTS_PER_NOTIFICATION } from '../events/task-event';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { TasksStoreModule } from '../tasks/tasks-store.module';
import {
  WORKER_TASK_STORE,
  type WorkerTaskStore,
} from '../tasks/worker-task-store';
import { JOB_SOURCE, type JobSource } from './job-source';
import { ActiveRuns } from './active-runs';
import { DeadLetterHandler } from './dead-letter-handler';
import { RandomFaultInjector } from './fault-injector';
import { ProgressReporter } from './progress-reporter';
import { PurgeHandler } from './purge-handler';
import { TaskConsumer } from './task-consumer';
import { TaskProcessor } from './task-processor';
import { WorkerLifecycle } from './worker-lifecycle';

@Module({
  imports: [TasksStoreModule],
  providers: [
    ActiveRuns,
    {
      provide: ProgressReporter,
      inject: [WORKER_TASK_STORE, APP_CONFIG, ActiveRuns],
      useFactory: (
        store: WorkerTaskStore,
        config: AppConfig,
        runs: ActiveRuns,
      ) =>
        new ProgressReporter(
          store,
          {
            flushIntervalMs: config.worker.progressFlushIntervalMs,
            maxBatch: MAX_EVENTS_PER_NOTIFICATION,
          },
          (update) => runs.revoke(update.taskId, update.attempt),
        ),
    },
    {
      provide: TaskProcessor,
      inject: [WORKER_TASK_STORE, ProgressReporter, ActiveRuns, APP_CONFIG],
      useFactory: (
        store: WorkerTaskStore,
        reporter: ProgressReporter,
        runs: ActiveRuns,
        config: AppConfig,
      ) =>
        new TaskProcessor(
          store,
          reporter,
          runs,
          systemClock,
          new RandomFaultInjector(config.worker.simulatedFailureRate),
          `${hostname()}:${process.pid}`,
        ),
    },
    {
      provide: TaskConsumer,
      inject: [JOB_SOURCE, TaskProcessor, APP_CONFIG],
      useFactory: (
        source: JobSource,
        processor: TaskProcessor,
        config: AppConfig,
      ) =>
        new TaskConsumer(source, processor, {
          concurrency: config.worker.concurrency,
          fetchBatch: config.worker.fetchBatch,
          pollIntervalMs: config.worker.pollIntervalMs,
          burstDelayMs: 25,
          heartbeatRefreshMs: (config.tasks.heartbeatSeconds * 1000) / 3,
          shutdownTimeoutMs: config.worker.shutdownTimeoutMs,
        }),
    },
    { provide: DeadLetterHandler, useClass: DeadLetterHandler },
    {
      provide: PurgeHandler,
      inject: [WORKER_TASK_STORE, APP_CONFIG],
      useFactory: (store: WorkerTaskStore, config: AppConfig) =>
        new PurgeHandler(store, config),
    },
    WorkerLifecycle,
  ],
})
export class WorkerRuntimeModule {}
