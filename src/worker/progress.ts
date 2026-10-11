export const MIN_TICK_MS = 1000;

export function progressTickMs(durationMs: number): number {
  return Math.max(MIN_TICK_MS, Math.ceil(durationMs / 100));
}

export function progressAt(workedMs: number, durationMs: number): number {
  if (workedMs <= 0) {
    return 0;
  }
  if (workedMs >= durationMs) {
    return 100;
  }
  return Math.floor((workedMs * 100) / durationMs);
}

export function workedMsFromProgress(
  progress: number,
  durationMs: number,
): number {
  return Math.round((progress * durationMs) / 100);
}

export function nextDelayMs(
  workedMs: number,
  durationMs: number,
  tickMs: number,
): number {
  const untilEnd = durationMs - workedMs;
  const untilTick = tickMs - (workedMs % tickMs);
  return Math.max(1, Math.min(untilEnd, untilTick));
}
