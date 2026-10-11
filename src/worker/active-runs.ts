import { ABORT_CLAIM_LOST } from './abort-reasons';

export class ActiveRuns {
  private readonly controllers = new Map<string, AbortController>();

  register(taskId: string, attempt: number): AbortController {
    const controller = new AbortController();
    this.controllers.set(ActiveRuns.key(taskId, attempt), controller);
    return controller;
  }

  release(taskId: string, attempt: number, controller: AbortController): void {
    const key = ActiveRuns.key(taskId, attempt);
    if (this.controllers.get(key) === controller) {
      this.controllers.delete(key);
    }
  }

  revoke(taskId: string, attempt: number): void {
    this.controllers
      .get(ActiveRuns.key(taskId, attempt))
      ?.abort(ABORT_CLAIM_LOST);
  }

  get size(): number {
    return this.controllers.size;
  }

  private static key(taskId: string, attempt: number): string {
    return `${taskId}:${attempt}`;
  }
}
