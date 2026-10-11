import type { TaskState } from './task.types';

export interface TaskStateReader {
  findState(id: string): Promise<TaskState | null>;
  findStates(ids: readonly string[]): Promise<TaskState[]>;
}

export const TASK_STATE_READER = Symbol('TASK_STATE_READER');
