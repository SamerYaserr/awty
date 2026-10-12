import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Client, type Notification } from 'pg';

import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { TASK_EVENTS_CHANNEL, decodeEvents } from '../events/task-event';
import { SubscriptionRegistry } from './subscription-registry';

const MAX_RETRY_DELAY_MS = 5_000;

@Injectable()
export class TaskEventsListener
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TaskEventsListener.name);
  private readonly connectedHandlers: Array<() => void> = [];
  private client?: Client;
  private retryTimer?: NodeJS.Timeout;
  private failures = 0;
  private stopping = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly registry: SubscriptionRegistry,
  ) {}

  onApplicationBootstrap(): void {
    void this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.retryTimer);
    const client = this.client;
    this.client = undefined;
    if (client) {
      client.removeAllListeners();
      await client.end().catch(() => undefined);
    }
  }

  isReady(): boolean {
    return this.client !== undefined;
  }

  onConnected(handler: () => void): void {
    this.connectedHandlers.push(handler);
  }

  private async connect(): Promise<void> {
    if (this.stopping) {
      return;
    }
    const client = new Client({
      connectionString: this.config.db.url,
      ssl: this.config.db.ssl || undefined,
      application_name: 'awty-api-listen',
      keepAlive: true,
    });
    client.on('notification', (message) => this.onNotification(message));
    client.on('error', (error) => {
      this.logger.error(`Listener connection error: ${error.message}`);
      this.lost(client);
    });
    client.on('end', () => this.lost(client));

    try {
      await client.connect();
      await client.query(`LISTEN ${TASK_EVENTS_CHANNEL}`);
    } catch (error) {
      this.logger.error(
        `Could not start listening: ${(error as Error).message}`,
      );
      this.lost(client);
      return;
    }

    this.client = client;
    this.failures = 0;
    this.logger.log(`Listening on channel ${TASK_EVENTS_CHANNEL}`);
    for (const handler of this.connectedHandlers) {
      handler();
    }
  }

  private lost(client: Client): void {
    client.removeAllListeners();
    void client.end().catch(() => undefined);
    if (this.client === client) {
      this.client = undefined;
    }
    if (this.stopping || this.retryTimer) {
      return;
    }
    const base = Math.min(MAX_RETRY_DELAY_MS, 250 * 2 ** this.failures);
    const delay = Math.round(base * (0.5 + Math.random() / 2));
    this.failures += 1;
    this.logger.warn(`Reconnecting the listener in ${delay} ms`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect();
    }, delay);
  }

  private onNotification(message: Notification): void {
    if (message.channel !== TASK_EVENTS_CHANNEL || !message.payload) {
      return;
    }
    this.registry.publishAll(decodeEvents(message.payload));
  }
}
