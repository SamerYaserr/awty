import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DataSource } from 'typeorm';

import { TaskEventsListener } from '../realtime/task-events.listener';

const DATABASE_CHECK_TIMEOUT_MS = 2000;

@Controller('health')
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly listener: TaskEventsListener,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const database = await this.databaseIsUp();
    const listener = this.listener.isReady();
    const ok = database && listener;
    if (!ok) {
      res.status(503);
    }
    return {
      status: ok ? 'ok' : 'unavailable',
      checks: {
        database: database ? 'up' : 'down',
        listener: listener ? 'up' : 'down',
      },
    };
  }

  private async databaseIsUp(): Promise<boolean> {
    const check = this.dataSource.query('SELECT 1').then(
      () => true,
      () => false,
    );
    const timeout = new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), DATABASE_CHECK_TIMEOUT_MS).unref(),
    );
    return Promise.race([check, timeout]);
  }
}
