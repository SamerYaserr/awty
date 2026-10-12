import { Module } from '@nestjs/common';

import { TasksStoreModule } from '../tasks/tasks-store.module';
import { Reconciler } from './reconciler';
import { RealtimeServer } from './realtime.server';
import { SubscriptionRegistry } from './subscription-registry';
import { TaskEventsListener } from './task-events.listener';

@Module({
  imports: [TasksStoreModule],
  providers: [
    SubscriptionRegistry,
    TaskEventsListener,
    Reconciler,
    RealtimeServer,
  ],
  exports: [TaskEventsListener, RealtimeServer],
})
export class RealtimeModule {}
