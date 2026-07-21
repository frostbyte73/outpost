export interface LoggedEvent {
  seq: number;
  message: unknown;
  at: number;
}

export interface EventLogOpts {
  maxEvents: number;
  maxAgeMs: number;
}

// Per-session ring buffer of (seq, message, at) tuples. Backs replay-on-reconnect: a
// client says "I last saw seq N, send me what's newer." Bounded by event count AND wall
// clock so a long-idle session can't keep megabytes around forever, and a chatty session
// can't blow past the cap.
export class EventLog {
  private buffer: LoggedEvent[] = [];
  private nextSeq = 1;
  private readonly maxEvents: number;
  private readonly maxAgeMs: number;

  constructor(opts: EventLogOpts) {
    this.maxEvents = opts.maxEvents;
    this.maxAgeMs = opts.maxAgeMs;
  }

  push(message: unknown): LoggedEvent {
    const evt: LoggedEvent = { seq: this.nextSeq++, message, at: Date.now() };
    this.buffer.push(evt);
    this.gc();
    return evt;
  }

  // Exclusive of `since`. Empty array when nothing newer is held.
  replayFrom(since: number): LoggedEvent[] {
    const out: LoggedEvent[] = [];
    for (const e of this.buffer) if (e.seq > since) out.push(e);
    return out;
  }

  // Oldest seq still resident, or the next-to-be-assigned seq when empty.
  earliestSeq(): number {
    return this.buffer[0]?.seq ?? this.nextSeq;
  }

  // Most recent seq pushed, or 0 when empty.
  latestSeq(): number {
    return this.nextSeq - 1;
  }

  private gc(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    while (this.buffer.length > 0 && this.buffer[0]!.at < cutoff) {
      this.buffer.shift();
    }
    while (this.buffer.length > this.maxEvents) {
      this.buffer.shift();
    }
  }
}
