import { Module } from '@nestjs/common';

import { TASK_STATE_READER } from './task-state-reader';
import { TasksRepository } from './tasks.repository';

@Module({
  providers: [
    TasksRepository,
    { provide: TASK_STATE_READER, useExisting: TasksRepository },
  ],
  exports: [TasksRepository, TASK_STATE_READER],
})
export class TasksStoreModule {}
