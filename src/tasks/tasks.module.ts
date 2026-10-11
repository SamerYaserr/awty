import { Module } from '@nestjs/common';

import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TasksStoreModule } from './tasks-store.module';

@Module({
  imports: [TasksStoreModule],
  controllers: [TasksController],
  providers: [TasksService],
})
export class TasksModule {}
