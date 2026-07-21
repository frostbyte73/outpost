import { execFileSync } from 'node:child_process';

// Snapshot shape matches the `rate_limits` slot of claude's statusLine JSON so the PWA can
// reuse its existing meter render path. resets_at is unix epoch *seconds* (claude's
// statusLine convention); we convert from the ISO string the OAuth endpoint returns.
export interface AccountUsageSnapshot {
  five_hour?: { used_percentage: number; resets_at: number };
  seven_day?: { used_percentage: number; resets_at: number };
}

export interface UsagePollerOpts {
  onSnapshot: (snap: AccountUsageSnapshot) => void;
  // Test seams.
  fetch?: typeof fetch;
  readToken?: () => string | null;
}

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

const MIN_INTERVAL_SEC = 30;
const MAX_INTERVAL_SEC = 300;
const RAMP_UTIL = 90; // % utilization at which we hit MIN_INTERVAL_SEC
const NO_TOKEN_RETRY_SEC = 600; // re-check keychain every 10min in case claude logs in later
const MAX_ERROR_BACKOFF = 8; // ×interval; with 5min base that's a 40min cap
const RETRY_AFTER_CAP_SEC = 3600; // don't let a server-sent Retry-After stall the poller >1h

// Linear ramp: 0% util → 5min poll, 90%+ util → 30s poll. Below 90% interpolates linearly.
// Account usage is account-wide and creeps slowly when idle, so 5min is cheap; we only
// need fast updates when you're actually close to a cap.
function intervalForUtilization(utilPercent: number): number {
  const clamped = Math.min(RAMP_UTIL, Math.max(0, utilPercent));
  return Math.round(MAX_INTERVAL_SEC - (clamped / RAMP_UTIL) * (MAX_INTERVAL_SEC - MIN_INTERVAL_SEC));
}

export class UsagePoller {
  readonly id = 'usage';
  readonly name = 'Account usage (5h / 7d)';
  readonly description = "Polls claude.ai's OAuth usage endpoint on a usage-adaptive cadence.";
  // Adaptive/self-scheduling: the next tick is computed from current utilization, so
  // there's no fixed interval to advertise as a nextRunAt.
  readonly intervalMs: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private errorBackoff = 1;
  private lastRunAt: number | null = null;
  private lastError: string | null = null;
  private readonly opts: UsagePollerOpts;
  private readonly fetchImpl: typeof fetch;
  private readonly readToken: () => string | null;

  constructor(opts: UsagePollerOpts) {
    this.opts = opts;
    this.fetchImpl = opts.fetch ?? fetch;
    this.readToken = opts.readToken ?? defaultReadToken;
  }

  status(): { lastRunAt: number | null; lastError: string | null; running: boolean } {
    return { lastRunAt: this.lastRunAt, lastError: this.lastError, running: false };
  }

  // Manual run: fetches once without touching the automatic reschedule loop (the
  // pending timer keeps its own cadence).
  async runNow(): Promise<void> {
    await this.pollOnce();
  }

  start(): void {
    this.stopped = false;
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private schedule(seconds: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), seconds * 1000);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    this.schedule(await this.pollOnce());
  }

  // Performs one fetch, updates the snapshot and last-run status, and returns the number
  // of seconds until the next automatic run should fire. Never schedules itself — the
  // caller decides whether to re-arm (tick does; runNow doesn't).
  private async pollOnce(): Promise<number> {
    const token = this.readToken();
    if (!token) {
      // Claude CLI not authenticated via OAuth (API-key billing, or signed out). Keep
      // checking on a long cadence so a later login is picked up without a daemon restart.
      return NO_TOKEN_RETRY_SEC;
    }
    try {
      const res = await this.fetchImpl(USAGE_URL, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        this.lastRunAt = Date.now();
        // 429 (rate limited) / 529 (overloaded) carry a Retry-After telling us exactly how
        // long to wait — honor it verbatim (clamped) instead of guessing, so we neither
        // re-hammer the endpoint nor sit idle longer than asked. Don't compound errorBackoff
        // on a throttle we were told to ride out.
        if (res.status === 429 || res.status === 529) {
          const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
          this.lastError = `usage endpoint throttled (${res.status})`;
          if (retryAfter !== null) return retryAfter;
        } else {
          this.lastError = `usage endpoint returned ${res.status}`;
        }
        // 401 means token rotated/expired — next tick will re-read keychain. Any other 4xx/5xx,
        // or a throttle with no Retry-After: exponential back off.
        this.errorBackoff = Math.min(MAX_ERROR_BACKOFF, this.errorBackoff * 2);
        return MAX_INTERVAL_SEC * this.errorBackoff;
      }
      const body = await res.json() as {
        five_hour?: { utilization?: number; resets_at?: string };
        seven_day?: { utilization?: number; resets_at?: string };
      };
      const snap: AccountUsageSnapshot = {};
      if (body.five_hour && typeof body.five_hour.utilization === 'number') {
        snap.five_hour = {
          used_percentage: body.five_hour.utilization,
          resets_at: isoToEpochSeconds(body.five_hour.resets_at),
        };
      }
      if (body.seven_day && typeof body.seven_day.utilization === 'number') {
        snap.seven_day = {
          used_percentage: body.seven_day.utilization,
          resets_at: isoToEpochSeconds(body.seven_day.resets_at),
        };
      }
      this.opts.onSnapshot(snap);
      this.errorBackoff = 1;
      this.lastRunAt = Date.now();
      this.lastError = null;
      const maxUtil = Math.max(
        snap.five_hour?.used_percentage ?? 0,
        snap.seven_day?.used_percentage ?? 0,
      );
      return intervalForUtilization(maxUtil);
    } catch (e) {
      this.errorBackoff = Math.min(MAX_ERROR_BACKOFF, this.errorBackoff * 2);
      this.lastRunAt = Date.now();
      this.lastError = (e as Error).message;
      return MAX_INTERVAL_SEC * this.errorBackoff;
    }
  }
}

// Retry-After is either a delta in seconds ("120") or an HTTP-date. Returns the number of
// seconds to wait, clamped to [MIN_INTERVAL_SEC, RETRY_AFTER_CAP_SEC], or null if unparseable.
export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  let seconds: number;
  if (/^\d+$/.test(trimmed)) {
    seconds = Number(trimmed);
  } else {
    const when = Date.parse(trimmed);
    if (!Number.isFinite(when)) return null;
    seconds = Math.ceil((when - Date.now()) / 1000);
  }
  if (!Number.isFinite(seconds)) return null;
  return Math.min(RETRY_AFTER_CAP_SEC, Math.max(MIN_INTERVAL_SEC, seconds));
}

function isoToEpochSeconds(iso: string | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

function defaultReadToken(): string | null {
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(String(out).trim()) as { claudeAiOauth?: { accessToken?: string } };
    return parsed.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}
