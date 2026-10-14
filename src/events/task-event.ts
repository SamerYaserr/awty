import type { TaskState } from '../tasks/task.types';

export const TASK_EVENTS_CHANNEL = 'awty_task_events';

export const MAX_EVENTS_PER_NOTIFICATION = 100;

export type TaskEventKind = 'progress' | 'completed' | 'failed' | 'pending';

export interface TaskEvent {
  taskId: string;
  kind: TaskEventKind;
  progress: number;
}

const KIND_BY_CODE = new Map<string, TaskEventKind>([
  ['p', 'progress'],
  ['c', 'completed'],
  ['f', 'failed'],
  ['d', 'pending'],
]);

export function decodeEvents(payload: string): TaskEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const events: TaskEvent[] = [];
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== 3) {
      continue;
    }
    const [taskId, code, progress] = entry as unknown[];
    const kind = typeof code === 'string' ? KIND_BY_CODE.get(code) : undefined;
    if (typeof taskId !== 'string' || !kind) {
      continue;
    }
    if (typeof progress !== 'number' || !Number.isFinite(progress)) {
      continue;
    }
    events.push({ taskId, kind, progress });
  }
  return events;
}

export function stateToEvent(state: TaskState): TaskEvent {
  switch (state.status) {
    case 'completed':
      return { taskId: state.id, kind: 'completed', progress: 100 };
    case 'failed':
      return { taskId: state.id, kind: 'failed', progress: state.progress };
    case 'pending':
      return { taskId: state.id, kind: 'pending', progress: state.progress };
    default:
      return { taskId: state.id, kind: 'progress', progress: state.progress };
  }
}
