import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import { chunk } from '../common/chunk';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { stateToEvent } from '../events/task-event';
import {
  TASK_STATE_READER,
  type TaskStateReader,
} from '../tasks/task-state-reader';
import { SubscriptionRegistry } from './subscription-registry';
import { TaskEventsListener } from './task-events.listener';

const LOOKUP_BATCH = 500;

@Injectable()
export class Reconciler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(Reconciler.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly registry: SubscriptionRegistry,
    private readonly listener: TaskEventsListener,
    @Inject(TASK_STATE_READER) private readonly states: TaskStateReader,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.listener.onConnected(() => void this.reconcile());
    this.timer = setInterval(
      () => void this.reconcile(),
      this.config.realtime.reconcileIntervalMs,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async reconcile(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      for (const ids of chunk(this.registry.activeTaskIds(), LOOKUP_BATCH)) {
        const states = await this.states.findStates(ids);
        const found = new Set<string>();
        for (const state of states) {
          found.add(state.id);
          this.registry.publish(stateToEvent(state));
        }
        for (const id of ids) {
          if (!found.has(id)) {
            this.registry.dropTask(id, 'Task not found');
          }
        }
      }
    } catch (error) {
      this.logger.warn(`Reconciliation failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
