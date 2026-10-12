import { z } from 'zod';

import type { TaskEvent } from '../events/task-event';

const taskIdSchema = z.string().min(1).max(100);

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), taskId: taskIdSchema }),
  z.object({ type: z.literal('unsubscribe'), taskId: taskIdSchema }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ServerMessage =
  | { type: 'progress'; taskId: string; progress: number }
  | { type: 'completed'; taskId: string }
  | { type: 'failed'; taskId: string }
  | { type: 'error'; taskId?: string; message: string };

export function toServerMessage(event: TaskEvent): ServerMessage {
  switch (event.kind) {
    case 'completed':
      return { type: 'completed', taskId: event.taskId };
    case 'failed':
      return { type: 'failed', taskId: event.taskId };
    default:
      return {
        type: 'progress',
        taskId: event.taskId,
        progress: event.progress,
      };
  }
}

export function isTerminalEvent(event: TaskEvent): boolean {
  return event.kind === 'completed' || event.kind === 'failed';
}

export function errorMessage(message: string, taskId?: string): ServerMessage {
  return taskId === undefined
    ? { type: 'error', message }
    : { type: 'error', taskId, message };
}

export function serialize(message: ServerMessage): string {
  return JSON.stringify(message);
}
