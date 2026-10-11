import { Logger } from '@nestjs/common';

import type { Clock } from '../common/clock';
import type { TaskClaim, WorkerTaskStore } from '../tasks/worker-task-store';
import { ABORT_CLAIM_LOST } from './abort-reasons';
import type { ActiveRuns } from './active-runs';
import type { FaultInjector } from './fault-injector';
import {
  nextDelayMs,
  progressAt,
  progressTickMs,
  workedMsFromProgress,
} from './progress';
import type { ProgressReporter } from './progress-reporter';

export type TaskOutcome =
  'completed' | 'failed' | 'skipped' | 'lost' | 'interrupted';

export class TaskProcessor {
  private readonly logger = new Logger(TaskProcessor.name);

  constructor(
    private readonly store: Pick<
      WorkerTaskStore,
      'claim' | 'complete' | 'fail'
    >,
    private readonly reporter: Pick<ProgressReporter, 'report' | 'discard'>,
    private readonly runs: ActiveRuns,
    private readonly clock: Clock,
    private readonly faults: FaultInjector,
    private readonly workerId: string,
  ) {}

  async process(taskId: string, outer: AbortSignal): Promise<TaskOutcome> {
    if (outer.aborted) {
      return 'interrupted';
    }
    const claim = await this.store.claim(taskId, this.workerId);
    if (!claim) {
      this.logger.warn(
        `Task ${taskId} is missing or already finished, nothing to do`,
      );
      return 'skipped';
    }

    const run = this.runs.register(taskId, claim.attempt);
    try {
      return await this.work(
        taskId,
        claim,
        AbortSignal.any([outer, run.signal]),
      );
    } finally {
      this.runs.release(taskId, claim.attempt, run);
    }
  }

  private async work(
    taskId: string,
    claim: TaskClaim,
    signal: AbortSignal,
  ): Promise<TaskOutcome> {
    const durationMs = claim.durationSeconds * 1000;
    const tickMs = progressTickMs(durationMs);

    const resumedMs = workedMsFromProgress(claim.progress, durationMs);
    const startedAt = this.clock.now();
    const failAt = this.faults.failAtPercent(
      taskId,
      claim.attempt,
      claim.progress,
    );
    let workedMs = resumedMs;
    let lastReported = claim.progress;

    this.logger.debug(
      `Task ${taskId} attempt ${claim.attempt} starts at ${claim.progress}%`,
    );

    while (workedMs < durationMs) {
      const delayMs = nextDelayMs(workedMs, durationMs, tickMs);
      await this.clock.sleep(delayMs, signal);
      if (signal.aborted) {
        return this.abortOutcome(taskId, signal);
      }

      workedMs = Math.max(
        workedMs + delayMs,
        resumedMs + (this.clock.now() - startedAt),
      );

      const progress = progressAt(workedMs, durationMs);
      if (failAt !== null && progress >= failAt) {
        return this.failTask(taskId, claim.attempt, progress);
      }
      if (progress > lastReported && progress < 100) {
        this.reporter.report({ taskId, attempt: claim.attempt, progress });
        lastReported = progress;
      }
    }

    const completed = await this.store.complete(taskId, claim.attempt);
    this.reporter.discard(taskId);
    if (!completed) {
      this.logger.warn(
        `Task ${taskId} attempt ${claim.attempt} finished but no longer owns it`,
      );
    }
    return completed ? 'completed' : 'lost';
  }

  private async failTask(
    taskId: string,
    attempt: number,
    progress: number,
  ): Promise<TaskOutcome> {
    const failed = await this.store.fail(
      taskId,
      attempt,
      `Simulated processing failure at ${progress}%`,
    );
    this.reporter.discard(taskId);
    return failed ? 'failed' : 'lost';
  }

  private abortOutcome(taskId: string, signal: AbortSignal): TaskOutcome {
    if (signal.reason === ABORT_CLAIM_LOST) {
      this.reporter.discard(taskId);
      this.logger.warn(
        `Task ${taskId} was taken over by another worker, stopping this attempt`,
      );
      return 'lost';
    }
    return 'interrupted';
  }
}
