import { Module } from '@nestjs/common';

import { LoggingModule } from './common/logging.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { QueueModule } from './queue/queue.module';
import { TasksStoreModule } from './tasks/tasks-store.module';
import { WorkerRuntimeModule } from './worker/worker-runtime.module';

@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    DatabaseModule.forRole('worker'),
    QueueModule.register('worker'),
    TasksStoreModule,
    WorkerRuntimeModule,
  ],
})
export class WorkerModule {}
