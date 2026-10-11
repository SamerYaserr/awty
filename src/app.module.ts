import { Module } from '@nestjs/common';

import { LoggingModule } from './common/logging.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { QueueModule } from './queue/queue.module';
import { TasksModule } from './tasks/tasks.module';

@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    DatabaseModule.forRole('api'),
    QueueModule.register('api'),
    TasksModule,
  ],
})
export class AppModule {}
