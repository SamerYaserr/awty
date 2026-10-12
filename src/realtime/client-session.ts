import { Logger } from '@nestjs/common';

import { TokenBucket } from '../common/token-bucket';
import { stateToEvent } from '../events/task-event';
import { isUuid } from '../common/uuid';
import type { TaskStateReader } from '../tasks/task-state-reader';
import type { TaskState } from '../tasks/task.types';
import {
  clientMessageSchema,
  errorMessage,
  serialize,
  type ServerMessage,
} from './protocol';
import type { Subscriber, SubscriptionRegistry } from './subscription-registry';

export interface SocketLike {
  readonly bufferedAmount: number;
  readonly isOpen: boolean;
  send(data: string): void;
  close(code: number, reason: string): void;
  terminate(): void;
}

export interface SessionLimits {
  maxSubscriptions: number;
  maxBufferedBytes: number;
  messageBurst: number;
  messagesPerSecond: number;
}

export const CLOSE_POLICY_VIOLATION = 1008;

export class ClientSession implements Subscriber {
  private readonly logger = new Logger(ClientSession.name);
  private readonly bucket: TokenBucket;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly socket: SocketLike,
    private readonly registry: SubscriptionRegistry,
    private readonly states: Pick<TaskStateReader, 'findState'>,
    private readonly limits: SessionLimits,
    now: () => number = Date.now,
  ) {
    this.bucket = new TokenBucket(
      limits.messageBurst,
      limits.messagesPerSecond,
      now,
    );
  }

  onMessage(raw: string, isBinary: boolean): void {
    if (this.disposed) {
      return;
    }
    if (!this.bucket.take()) {
      this.socket.close(CLOSE_POLICY_VIOLATION, 'Rate limit exceeded');
      this.dispose();
      return;
    }
    this.chain = this.chain
      .then(() => this.handle(raw, isBinary))
      .catch((error: Error) =>
        this.logger.error(`Unhandled session error: ${error.message}`),
      );
  }

  dispose(): void {
    this.disposed = true;
    this.registry.removeAll(this);
  }

  deliver(raw: string, droppable: boolean): void {
    if (this.disposed || !this.socket.isOpen) {
      return;
    }
    const buffered = this.socket.bufferedAmount;
    if (buffered > this.limits.maxBufferedBytes) {
      this.socket.terminate();
      this.dispose();
      return;
    }
    if (droppable && buffered > this.limits.maxBufferedBytes / 2) {
      return;
    }
    this.socket.send(raw);
  }

  private async handle(raw: string, isBinary: boolean): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (isBinary) {
      this.reject('Binary messages are not supported');
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.reject('Message is not valid JSON');
      return;
    }
    const parsed = clientMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.reject(
        'Unsupported message, expected {"type":"subscribe","taskId":"<id>"}',
      );
      return;
    }
    if (parsed.data.type === 'subscribe') {
      await this.subscribe(parsed.data.taskId);
    } else {
      this.registry.remove(parsed.data.taskId, this);
    }
  }

  private async subscribe(taskId: string): Promise<void> {
    if (!isUuid(taskId)) {
      this.reject('Task not found', taskId);
      return;
    }
    const alreadySubscribed = this.registry.has(taskId, this);
    if (
      !alreadySubscribed &&
      this.registry.countFor(this) >= this.limits.maxSubscriptions
    ) {
      this.reject('Subscription limit reached', taskId);
      return;
    }

    this.registry.add(taskId, this);

    let state: TaskState | null;
    try {
      state = await this.states.findState(taskId);
    } catch (error) {
      this.logger.error(
        `Could not read task ${taskId}: ${(error as Error).message}`,
      );
      this.registry.remove(taskId, this);
      this.reject('Temporarily unavailable, try again', taskId);
      return;
    }
    if (this.disposed) {
      return;
    }
    if (!state) {
      this.registry.remove(taskId, this);
      this.reject('Task not found', taskId);
      return;
    }
    this.registry.publishTo(this, stateToEvent(state));
  }

  private reject(message: string, taskId?: string): void {
    this.sendDirect(errorMessage(message, taskId));
  }

  private sendDirect(message: ServerMessage): void {
    if (this.socket.isOpen) {
      this.socket.send(serialize(message));
    }
  }
}
