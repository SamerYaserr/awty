export interface JobOptions {
  expireInSeconds: number;
  heartbeatSeconds: number;
}

export function jobOptionsFor(
  durationSeconds: number,
  settings: { heartbeatSeconds: number; expiryGraceSeconds: number },
): JobOptions {
  return {
    expireInSeconds: durationSeconds + settings.expiryGraceSeconds,
    heartbeatSeconds: settings.heartbeatSeconds,
  };
}
