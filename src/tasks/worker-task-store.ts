export interface TaskClaim {
  attempt: number;
  progress: number;
  durationSeconds: number;
}

export interface ProgressUpdate {
  taskId: string;
  attempt: number;
  progress: number;
}

export interface WorkerTaskStore {
  claim(taskId: string, workerId: string): Promise<TaskClaim | null>;

  flushProgress(updates: readonly ProgressUpdate[]): Promise<Set<string>>;

  complete(taskId: string, attempt: number): Promise<boolean>;

  fail(taskId: string, attempt: number, reason: string): Promise<boolean>;

  failExhausted(taskIds: readonly string[], reason: string): Promise<number>;

  purgeFinishedBefore(cutoff: Date, limit: number): Promise<number>;
}

export const WORKER_TASK_STORE = Symbol('WORKER_TASK_STORE');
