import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { IncomingMessage } from 'node:http';

import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import {
  TASK_STATE_READER,
  type TaskStateReader,
} from '../tasks/task-state-reader';
import {
  ClientSession,
  type SessionLimits,
  type SocketLike,
} from './client-session';
import { SubscriptionRegistry } from './subscription-registry';

export const WS_PATH = '/ws';
const MAX_MESSAGE_BYTES = 4096;
const CLOSE_GOING_AWAY = 1001;
const CLOSE_GRACE_MS = 2000;

interface Connection {
  ws: WebSocket;
  session: ClientSession;
  alive: boolean;
}

const toText = (data: RawData): string => {
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  return Array.isArray(data)
    ? Buffer.concat(data).toString('utf8')
    : Buffer.from(data).toString('utf8');
};

const asSocketLike = (ws: WebSocket): SocketLike => ({
  get bufferedAmount() {
    return ws.bufferedAmount;
  },
  get isOpen() {
    return ws.readyState === WebSocket.OPEN;
  },
  send: (data) =>
    ws.send(data, (error) => {
      if (error) {
        ws.terminate();
      }
    }),
  close: (code, reason) => ws.close(code, reason),
  terminate: () => ws.terminate(),
});

@Injectable()
export class RealtimeServer
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(RealtimeServer.name);
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  private readonly connections = new Set<Connection>();
  private readonly limits: SessionLimits;
  private pingTimer?: NodeJS.Timeout;
  private closing = false;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly registry: SubscriptionRegistry,
    @Inject(TASK_STATE_READER) private readonly states: TaskStateReader,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.limits = {
      maxSubscriptions: config.realtime.maxSubscriptions,
      maxBufferedBytes: config.realtime.maxBufferedBytes,
      messageBurst: 50,
      messagesPerSecond: 25,
    };
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  onApplicationBootstrap(): void {
    const server = this.httpAdapterHost.httpAdapter.getHttpServer() as Server;
    server.on('upgrade', (request, socket, head) =>
      this.onUpgrade(request, socket, head),
    );
    this.pingTimer = setInterval(
      () => this.pingAll(),
      this.config.realtime.pingIntervalMs,
    );
    this.pingTimer.unref();
    this.logger.log(`WebSocket endpoint ready at ${WS_PATH}`);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.closing = true;
    clearInterval(this.pingTimer);
    for (const { ws } of this.connections) {
      ws.close(CLOSE_GOING_AWAY, 'Server shutting down');
    }
    const deadline = Date.now() + CLOSE_GRACE_MS;
    while (this.connections.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    for (const { ws } of this.connections) {
      ws.terminate();
    }
    this.wss.close();
  }

  private onUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path !== WS_PATH) {
      this.refuse(socket, '404 Not Found');
      return;
    }
    if (this.closing) {
      this.refuse(socket, '503 Service Unavailable');
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws));
  }

  private accept(ws: WebSocket): void {
    const session = new ClientSession(
      asSocketLike(ws),
      this.registry,
      this.states,
      this.limits,
    );
    const connection: Connection = { ws, session, alive: true };
    this.connections.add(connection);

    ws.on('message', (data, isBinary) =>
      session.onMessage(toText(data), isBinary),
    );
    ws.on('pong', () => {
      connection.alive = true;
    });
    ws.on('error', (error) =>
      this.logger.debug(`Socket error: ${error.message}`),
    );
    ws.on('close', () => {
      session.dispose();
      this.connections.delete(connection);
    });
  }

  private pingAll(): void {
    for (const connection of this.connections) {
      if (!connection.alive) {
        connection.ws.terminate();
        continue;
      }
      connection.alive = false;
      connection.ws.ping();
    }
  }

  private refuse(socket: Duplex, status: string): void {
    socket.write(
      `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
    socket.destroy();
  }
}
