import { Module } from '@nestjs/common';

import { TASK_STATE_READER } from './task-state-reader';
import { WORKER_TASK_STORE } from './worker-task-store';
import { TasksRepository } from './tasks.repository';

@Module({
  providers: [
    TasksRepository,
    { provide: TASK_STATE_READER, useExisting: TasksRepository },
    { provide: WORKER_TASK_STORE, useExisting: TasksRepository },
  ],
  exports: [TasksRepository, TASK_STATE_READER, WORKER_TASK_STORE],
})
export class TasksStoreModule {}
