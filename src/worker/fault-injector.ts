export interface FaultInjector {
  failAtPercent(
    taskId: string,
    attempt: number,
    fromProgress: number,
  ): number | null;
}

export class RandomFaultInjector implements FaultInjector {
  constructor(
    private readonly rate: number,
    private readonly random: () => number = Math.random,
  ) {}

  failAtPercent(
    _taskId: string,
    _attempt: number,
    fromProgress: number,
  ): number | null {
    if (this.rate <= 0 || this.random() >= this.rate) {
      return null;
    }
    const lowest = fromProgress + 1;
    if (lowest > 99) {
      return null;
    }
    return lowest + Math.floor(this.random() * (100 - lowest));
  }
}
