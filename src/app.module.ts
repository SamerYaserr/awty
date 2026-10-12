import { Module } from '@nestjs/common';

import { LoggingModule } from './common/logging.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { QueueModule } from './queue/queue.module';
import { RealtimeModule } from './realtime/realtime.module';
import { TasksModule } from './tasks/tasks.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    DatabaseModule.forRole('api'),
    QueueModule.register('api'),
    TasksModule,
    RealtimeModule,
    HealthModule,
  ],
})
export class AppModule {}
