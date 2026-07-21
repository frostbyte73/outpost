// The daemon's built-in pollers (Linear, PR-watcher, user-PRs, usage) surfaced as
// read-only "system" schedules so the Schedules surface can show when each last ran,
// when it runs next, and any last error, and offer a manual run-now. They are not
// persisted and not editable — this adapter only observes the live poller objects.
//
// Kept structural on purpose: a poller satisfies SystemPoller by shape alone, so the
// integrations cluster never imports from here (schedules depends on nobody; see
// types.ts). Adding a new poller (e.g. Slack) is `systemSchedules.register(poller)`
// once it exposes {id, name, intervalMs, status(), runNow()}.

export interface SystemPollerStatus {
  lastRunAt: number | null;
  lastError: string | null;
  running: boolean;
}

export interface SystemPoller {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  // Fixed interval between automatic runs, or null for an adaptive/self-scheduling
  // poller (usage) whose next run can't be predicted from a constant.
  readonly intervalMs: number | null;
  status(): SystemPollerStatus;
  runNow(): Promise<void>;
}

export interface SystemScheduleDescriptor {
  id: string;
  kind: 'system';
  name: string;
  description: string | null;
  intervalMs: number | null;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastError: string | null;
  running: boolean;
}

export class SystemScheduleRegistry {
  private pollers: SystemPoller[] = [];

  register(poller: SystemPoller): void {
    this.pollers.push(poller);
  }

  private describe(p: SystemPoller): SystemScheduleDescriptor {
    const s = p.status();
    return {
      id: p.id,
      kind: 'system',
      name: p.name,
      description: p.description ?? null,
      intervalMs: p.intervalMs,
      lastRunAt: s.lastRunAt,
      nextRunAt: p.intervalMs != null && s.lastRunAt != null ? s.lastRunAt + p.intervalMs : null,
      lastError: s.lastError,
      running: s.running,
    };
  }

  list(): SystemScheduleDescriptor[] {
    return this.pollers.map((p) => this.describe(p));
  }

  // Triggers a manual run and returns the refreshed descriptor. The poller's own error
  // is swallowed and reported through the descriptor's `lastError` instead of thrown, so
  // the route answers 200 with the new status rather than 500.
  async runNow(id: string): Promise<SystemScheduleDescriptor | null> {
    const p = this.pollers.find((x) => x.id === id);
    if (!p) return null;
    try {
      await p.runNow();
    } catch {
      // surfaced via status().lastError
    }
    return this.describe(p);
  }
}
