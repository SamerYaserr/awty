export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = now();
  }

  take(): boolean {
    const nowMs = this.now();
    const elapsedSeconds = (nowMs - this.lastRefillMs) / 1000;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsedSeconds * this.refillPerSecond,
    );
    this.lastRefillMs = nowMs;
    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }
}
