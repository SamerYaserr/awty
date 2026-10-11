import { Column, Entity, PrimaryColumn } from 'typeorm';

import type { TaskStatus } from '../task.types';

@Entity({ name: 'tasks' })
export class TaskEntity {
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ type: 'text' })
  status: TaskStatus;

  @Column({ name: 'duration_seconds', type: 'integer' })
  durationSeconds: number;

  @Column({ type: 'smallint' })
  progress: number;

  @Column({ type: 'integer' })
  attempt: number;

  @Column({ name: 'worker_id', type: 'text', nullable: true })
  workerId: string | null;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
