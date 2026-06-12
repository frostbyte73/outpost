export interface StopHookTrackerOpts {
  thresholdMs: number;
  now?: () => number;
}

export interface StopVerdict {
  shouldNotify: boolean;
  turnDurationMs: number | null;
}

export class StopHookTracker {
  private starts = new Map<string, number>();
  private readonly now: () => number;
  private readonly thresholdMs: number;

  constructor(opts: StopHookTrackerOpts) {
    this.now = opts.now ?? (() => Date.now());
    this.thresholdMs = opts.thresholdMs;
  }

  recordTurnStart(sessionId: string): void {
    this.starts.set(sessionId, this.now());
  }

  consume(sessionId: string): StopVerdict {
    const start = this.starts.get(sessionId);
    if (start === undefined) {
      return { shouldNotify: false, turnDurationMs: null };
    }
    this.starts.delete(sessionId);
    const turnDurationMs = this.now() - start;
    return { shouldNotify: turnDurationMs >= this.thresholdMs, turnDurationMs };
  }
}
