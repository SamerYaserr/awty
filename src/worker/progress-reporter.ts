import { Logger } from '@nestjs/common';

import { chunk } from '../common/chunk';
import { systemClock, type Clock } from '../common/clock';
import type {
  ProgressUpdate,
  WorkerTaskStore,
} from '../tasks/worker-task-store';

export interface ProgressReporterOptions {
  flushIntervalMs: number;
  maxBatch: number;
}

export class ProgressReporter {
  private readonly logger = new Logger(ProgressReporter.name);
  private readonly pending = new Map<string, ProgressUpdate>();
  private stopSignal = new AbortController();
  private running = false;
  private loop?: Promise<void>;
  private flushing?: Promise<void>;

  constructor(
    private readonly store: Pick<WorkerTaskStore, 'flushProgress'>,
    private readonly options: ProgressReporterOptions,
    private readonly onOwnershipLost: (update: ProgressUpdate) => void,
    private readonly clock: Clock = systemClock,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.stopSignal = new AbortController();
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopSignal.abort();
    await this.loop;
    await this.flush();
  }

  report(update: ProgressUpdate): void {
    this.pending.set(update.taskId, update);
  }

  discard(taskId: string): void {
    this.pending.delete(taskId);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  async flush(): Promise<void> {
    while (this.flushing) {
      await this.flushing;
    }
    if (this.pending.size === 0) {
      return;
    }
    const current = this.drain().finally(() => {
      this.flushing = undefined;
    });
    this.flushing = current;
    await current;
  }

  private async run(): Promise<void> {
    while (this.running) {
      await this.clock.sleep(
        this.options.flushIntervalMs,
        this.stopSignal.signal,
      );
      if (this.running) {
        await this.flush();
      }
    }
  }

  private async drain(): Promise<void> {
    const batch = [...this.pending.values()];
    this.pending.clear();
    for (const part of chunk(batch, this.options.maxBatch)) {
      try {
        const applied = await this.store.flushProgress(part);
        for (const update of part) {
          if (!applied.has(update.taskId)) {
            this.onOwnershipLost(update);
          }
        }
      } catch (error) {
        this.logger.warn(
          `Progress write failed, will retry: ${(error as Error).message}`,
        );
        for (const update of part) {
          if (!this.pending.has(update.taskId)) {
            this.pending.set(update.taskId, update);
          }
        }
      }
    }
  }
}
