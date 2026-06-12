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

// Linear ramp: 0% util → 5min poll, 90%+ util → 30s poll. Below 90% interpolates linearly.
// Account usage is account-wide and creeps slowly when idle, so 5min is cheap; we only
// need fast updates when you're actually close to a cap.
function intervalForUtilization(utilPercent: number): number {
  const clamped = Math.min(RAMP_UTIL, Math.max(0, utilPercent));
  return Math.round(MAX_INTERVAL_SEC - (clamped / RAMP_UTIL) * (MAX_INTERVAL_SEC - MIN_INTERVAL_SEC));
}

export class UsagePoller {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private errorBackoff = 1;
  private readonly opts: UsagePollerOpts;
  private readonly fetchImpl: typeof fetch;
  private readonly readToken: () => string | null;

  constructor(opts: UsagePollerOpts) {
    this.opts = opts;
    this.fetchImpl = opts.fetch ?? fetch;
    this.readToken = opts.readToken ?? defaultReadToken;
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
    const token = this.readToken();
    if (!token) {
      // Claude CLI not authenticated via OAuth (API-key billing, or signed out). Keep
      // checking on a long cadence so a later login is picked up without a daemon restart.
      this.schedule(NO_TOKEN_RETRY_SEC);
      return;
    }
    try {
      const res = await this.fetchImpl(USAGE_URL, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        // 401 means token rotated/expired — next tick will re-read keychain. 4xx/5xx for
        // any other reason: back off. Same code path either way.
        this.errorBackoff = Math.min(MAX_ERROR_BACKOFF, this.errorBackoff * 2);
        this.schedule(MAX_INTERVAL_SEC * this.errorBackoff);
        return;
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
      const maxUtil = Math.max(
        snap.five_hour?.used_percentage ?? 0,
        snap.seven_day?.used_percentage ?? 0,
      );
      this.schedule(intervalForUtilization(maxUtil));
    } catch {
      this.errorBackoff = Math.min(MAX_ERROR_BACKOFF, this.errorBackoff * 2);
      this.schedule(MAX_INTERVAL_SEC * this.errorBackoff);
    }
  }
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

// Exported for tests.
export const _internals = { intervalForUtilization, isoToEpochSeconds };
