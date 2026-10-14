import { Logger } from '@nestjs/common';

import {
  isTerminalEvent,
  serialize,
  toServerMessage,
  errorMessage,
} from './protocol';
import type { TaskEvent, TaskEventKind } from '../events/task-event';

export interface Subscriber {
  deliver(raw: string, droppable: boolean): void;
}

interface Subscription {
  lastProgress: number;
  lastKind?: TaskEventKind;
}

export class SubscriptionRegistry {
  private readonly logger = new Logger(SubscriptionRegistry.name);
  private readonly byTask = new Map<string, Map<Subscriber, Subscription>>();
  private readonly bySubscriber = new Map<Subscriber, Set<string>>();

  add(taskId: string, subscriber: Subscriber): boolean {
    let subscriptions = this.byTask.get(taskId);
    if (!subscriptions) {
      subscriptions = new Map();
      this.byTask.set(taskId, subscriptions);
    }
    const isNew = !subscriptions.has(subscriber);
    subscriptions.set(subscriber, { lastProgress: -1 });

    let taskIds = this.bySubscriber.get(subscriber);
    if (!taskIds) {
      taskIds = new Set();
      this.bySubscriber.set(subscriber, taskIds);
    }
    taskIds.add(taskId);
    return isNew;
  }

  has(taskId: string, subscriber: Subscriber): boolean {
    return this.byTask.get(taskId)?.has(subscriber) ?? false;
  }

  countFor(subscriber: Subscriber): number {
    return this.bySubscriber.get(subscriber)?.size ?? 0;
  }

  remove(taskId: string, subscriber: Subscriber): void {
    const subscriptions = this.byTask.get(taskId);
    if (subscriptions) {
      subscriptions.delete(subscriber);
      if (subscriptions.size === 0) {
        this.byTask.delete(taskId);
      }
    }
    const taskIds = this.bySubscriber.get(subscriber);
    if (taskIds) {
      taskIds.delete(taskId);
      if (taskIds.size === 0) {
        this.bySubscriber.delete(subscriber);
      }
    }
  }

  removeAll(subscriber: Subscriber): void {
    const taskIds = this.bySubscriber.get(subscriber);
    if (!taskIds) {
      return;
    }
    for (const taskId of [...taskIds]) {
      this.remove(taskId, subscriber);
    }
  }

  activeTaskIds(): string[] {
    return [...this.byTask.keys()];
  }

  get taskCount(): number {
    return this.byTask.size;
  }

  get subscriberCount(): number {
    return this.bySubscriber.size;
  }

  publish(event: TaskEvent): void {
    const subscriptions = this.byTask.get(event.taskId);
    if (!subscriptions) {
      return;
    }
    let raw: string | undefined;
    const encode = (): string => (raw ??= serialize(toServerMessage(event)));
    for (const [subscriber, subscription] of subscriptions) {
      this.apply(event, subscriber, subscription, encode);
    }
  }

  publishAll(events: readonly TaskEvent[]): void {
    for (const event of events) {
      this.publish(event);
    }
  }

  publishTo(subscriber: Subscriber, event: TaskEvent): void {
    const subscription = this.byTask.get(event.taskId)?.get(subscriber);
    if (!subscription) {
      return;
    }
    this.apply(event, subscriber, subscription, () =>
      serialize(toServerMessage(event)),
    );
  }

  dropTask(taskId: string, message: string): void {
    const subscriptions = this.byTask.get(taskId);
    if (!subscriptions) {
      return;
    }
    const raw = serialize(errorMessage(message, taskId));
    for (const subscriber of [...subscriptions.keys()]) {
      this.safeDeliver(subscriber, raw, false);
      this.remove(taskId, subscriber);
    }
  }

  private apply(
    event: TaskEvent,
    subscriber: Subscriber,
    subscription: Subscription,
    encode: () => string,
  ): void {
    if (isTerminalEvent(event)) {
      this.safeDeliver(subscriber, encode(), false);
      this.remove(event.taskId, subscriber);
      return;
    }
    if (
      event.kind === 'pending' &&
      subscription.lastKind === 'pending' &&
      subscription.lastProgress === event.progress
    ) {
      return;
    }
    if (event.kind === 'pending') {
      subscription.lastKind = 'pending';
      subscription.lastProgress = event.progress;
      this.safeDeliver(subscriber, encode(), false);
      return;
    }
    if (event.progress <= subscription.lastProgress) {
      return;
    }
    subscription.lastKind = 'progress';
    subscription.lastProgress = event.progress;
    this.safeDeliver(subscriber, encode(), true);
  }

  private safeDeliver(
    subscriber: Subscriber,
    raw: string,
    droppable: boolean,
  ): void {
    try {
      subscriber.deliver(raw, droppable);
    } catch (error) {
      this.logger.warn(
        `Delivery to a subscriber failed: ${(error as Error).message}`,
      );
    }
  }
}
