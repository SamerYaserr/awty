export const QUEUES = {
  process: 'awty.task.process',
  dead: 'awty.task.dead',
  purge: 'awty.task.purge',
} as const;

export interface TaskJobData {
  taskId: string;
}

export const PG_BOSS = Symbol('PG_BOSS');
