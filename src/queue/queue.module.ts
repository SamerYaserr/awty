import {
  DynamicModule,
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import type PgBoss from 'pg-boss';

import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { TASK_QUEUE } from '../tasks/task-queue';
import { JOB_SOURCE } from '../worker/job-source';
import { startBoss } from './pg-boss.factory';
import { PgBossJobSource } from './pg-boss-job-source';
import { PgBossTaskQueue } from './pg-boss-task-queue';
import { PG_BOSS } from './queue.constants';

@Injectable()
class PgBossShutdown implements OnApplicationShutdown {
  constructor(@Inject(PG_BOSS) private readonly boss: PgBoss) {}

  async onApplicationShutdown(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }
}

@Global()
@Module({})
export class QueueModule {
  static register(role: 'api' | 'worker'): DynamicModule {
    const boss: Provider = {
      provide: PG_BOSS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => startBoss(config, role),
    };
    const roleProvider: Provider =
      role === 'api'
        ? { provide: TASK_QUEUE, useClass: PgBossTaskQueue }
        : { provide: JOB_SOURCE, useClass: PgBossJobSource };

    return {
      module: QueueModule,
      providers: [boss, roleProvider, PgBossShutdown],
      exports: [PG_BOSS, role === 'api' ? TASK_QUEUE : JOB_SOURCE],
    };
  }
}
