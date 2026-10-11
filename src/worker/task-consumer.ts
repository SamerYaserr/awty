import { Logger } from '@nestjs/common';

import { systemClock, type Clock } from '../common/clock';
import { chunk } from '../common/chunk';
import { ABORT_CLAIM_LOST, ABORT_SHUTDOWN } from './abort-reasons';
import type { FetchedJob, JobRef, JobSource } from './job-source';
import type { TaskOutcome } from './task-processor';

export interface ConsumerOptions {
  concurrency: number;
  fetchBatch: number;
  pollIntervalMs: number;
  burstDelayMs: number;
  heartbeatRefreshMs: number;
  shutdownTimeoutMs: number;
}

interface InFlight {
  job: FetchedJob;
  controller: AbortController;
  done: Promise<void>;
}

const MAX_TOUCH_BATCH = 500;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const keyOf = (job: JobRef): string => `${job.id}:${job.retryCount}`;
const refOf = (job: JobRef): JobRef => ({
  id: job.id,
  retryCount: job.retryCount,
});

export class TaskConsumer {
  private readonly logger = new Logger(TaskConsumer.name);
  private readonly inFlight = new Map<string, InFlight>();
  private readonly interrupted: JobRef[] = [];
  private lifetime = new AbortController();
  private wake: AbortController | undefined;
  private running = false;
  private backlogLikely = false;
  private loops: Promise<void>[] = [];

  constructor(
    private readonly source: JobSource,
    private readonly processor: {
      process(taskId: string, signal: AbortSignal): Promise<TaskOutcome>;
    },
    private readonly options: ConsumerOptions,
    private readonly clock: Clock = systemClock,
    private readonly random: () => number = Math.random,
  ) {}

  get activeCount(): number {
    return this.inFlight.size;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.lifetime = new AbortController();
    this.loops = [this.fetchLoop(), this.heartbeatLoop()];
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.lifetime.abort();
    await Promise.allSettled(this.loops);

    for (const entry of this.inFlight.values()) {
      entry.controller.abort(ABORT_SHUTDOWN);
    }
    await this.waitForTasks(this.options.shutdownTimeoutMs);

    if (this.interrupted.length > 0) {
      const jobs = this.interrupted.splice(0);
      try {
        await this.source.fail(jobs, 'Worker shutting down');
        this.logger.log(
          `Handed ${jobs.length} running task(s) back to the queue`,
        );
      } catch (error) {
        this.logger.error(
          `Could not hand tasks back, they will be retried after the heartbeat window: ${describe(error)}`,
        );
      }
    }
  }

  private async fetchLoop(): Promise<void> {
    while (this.running) {
      const free = this.options.concurrency - this.inFlight.size;
      let wanted = 0;
      let fetched = 0;

      if (free > 0) {
        wanted = Math.min(free, this.options.fetchBatch);
        try {
          const startedAt = this.clock.now();
          const jobs = await this.source.fetch(wanted);
          fetched = jobs.length;
          this.logger.verbose(
            `Fetched ${fetched}/${wanted} job(s) in ${Math.round(this.clock.now() - startedAt)} ms`,
          );
          for (const job of jobs) {
            this.launch(job);
          }
        } catch (error) {
          this.logger.error(`Fetching jobs failed: ${describe(error)}`);
          await this.idle(this.jittered(this.options.pollIntervalMs * 4));
          continue;
        }
      }

      this.backlogLikely = wanted > 0 && fetched === wanted;
      if (this.backlogLikely && this.inFlight.size < this.options.concurrency) {
        await this.idle(this.options.burstDelayMs);
        continue;
      }
      await this.idle(this.jittered(this.options.pollIntervalMs));
    }
  }

  private jittered(ms: number): number {
    return Math.round(ms * (0.75 + this.random() * 0.5));
  }

  private async heartbeatLoop(): Promise<void> {
    while (this.running) {
      await this.clock.sleep(
        this.options.heartbeatRefreshMs,
        this.lifetime.signal,
      );
      if (this.running) {
        await this.refreshHeartbeats();
      }
    }
  }

  private async refreshHeartbeats(): Promise<void> {
    const entries = [...this.inFlight.values()];
    if (entries.length === 0) {
      return;
    }
    const refreshed = new Set<string>();
    try {
      for (const part of chunk(entries, MAX_TOUCH_BATCH)) {
        const ids = await this.source.touch(part.map((entry) => entry.job));
        if (!ids) {
          return;
        }
        ids.forEach((id) => refreshed.add(id));
      }
    } catch (error) {
      this.logger.warn(`Heartbeat refresh failed: ${describe(error)}`);
      return;
    }

    for (const entry of entries) {
      const stillRunning = this.inFlight.get(keyOf(entry.job)) === entry;
      if (stillRunning && !refreshed.has(entry.job.id)) {
        this.logger.warn(
          `Lost the claim on task ${entry.job.data.taskId}, stopping it`,
        );
        entry.controller.abort(ABORT_CLAIM_LOST);
      }
    }
  }

  private launch(job: FetchedJob): void {
    const entry: InFlight = {
      job,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    const key = keyOf(job);
    this.inFlight.set(key, entry);
    entry.done = this.run(entry).finally(() => {
      this.inFlight.delete(key);
      if (this.backlogLikely) {
        this.wake?.abort();
      }
    });
  }

  private async run(entry: InFlight): Promise<void> {
    const { job, controller } = entry;
    try {
      const outcome = await this.processor.process(
        job.data.taskId,
        controller.signal,
      );
      await this.settle(job, outcome);
    } catch (error) {
      this.logger.error(
        `Task ${job.data.taskId} attempt ${job.retryCount} errored: ${describe(error)}`,
      );
      await this.failQuietly(job, describe(error));
    }
  }

  private async settle(job: FetchedJob, outcome: TaskOutcome): Promise<void> {
    switch (outcome) {
      case 'completed':
      case 'failed':
      case 'skipped':
        try {
          await this.source.complete(refOf(job));
        } catch (error) {
          this.logger.warn(
            `Could not complete job ${job.id}: ${describe(error)}`,
          );
        }
        return;
      case 'interrupted':
        this.interrupted.push(refOf(job));
        return;
      case 'lost':
        return;
    }
  }

  private async failQuietly(job: FetchedJob, reason: string): Promise<void> {
    try {
      await this.source.fail([refOf(job)], reason);
    } catch (error) {
      this.logger.error(`Could not fail job ${job.id}: ${describe(error)}`);
    }
  }

  private async idle(ms: number): Promise<void> {
    const wake = new AbortController();
    this.wake = wake;
    await this.clock.sleep(
      ms,
      AbortSignal.any([wake.signal, this.lifetime.signal]),
    );
    if (this.wake === wake) {
      this.wake = undefined;
    }
  }

  private async waitForTasks(timeoutMs: number): Promise<void> {
    const pending = [...this.inFlight.values()].map((entry) => entry.done);
    if (pending.length === 0) {
      return;
    }
    const cancel = new AbortController();
    let timedOut = false;
    await Promise.race([
      Promise.allSettled(pending),
      this.clock.sleep(timeoutMs, cancel.signal).then(() => {
        timedOut = !cancel.signal.aborted;
      }),
    ]);
    cancel.abort();
    if (timedOut) {
      this.logger.warn(
        `${this.inFlight.size} task(s) did not stop within ${timeoutMs} ms`,
      );
    }
  }
}
