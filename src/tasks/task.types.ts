export const TASK_STATUSES = [
  'pending',
  'processing',
  'completed',
  'failed',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const MIN_DURATION_SECONDS = 1;
export const MAX_DURATION_SECONDS = 3600;

export interface TaskState {
  id: string;
  status: TaskStatus;
  progress: number;
}
