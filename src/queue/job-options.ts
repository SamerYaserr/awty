export interface JobOptions {
  expireInSeconds: number;
  retryLimit: number;
}

export function jobOptionsFor(
  _durationSeconds: number,
  settings: {
    heartbeatSeconds: number;
    expiryGraceSeconds: number;
    maxAttempts: number;
  },
): JobOptions {
  return {
    expireInSeconds: settings.heartbeatSeconds + settings.expiryGraceSeconds,
    retryLimit: Math.max(0, settings.maxAttempts - 1),
  };
}
