import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AccountUsageSnapshot } from './usage-poller.js';

// Per-model cost ledger for the usage-widget popover (burn rate, per-model split, runway).
// Fed one entry per statusline turn via record(). The statusline's cost.total_cost_usd is
// *cumulative for the session's lifetime*, not a per-turn delta — so we track the last-seen
// cumulative value per session and record only the increment. That last-seen map is persisted
// alongside the entries specifically so a daemon restart (routine during dev, see CLAUDE.md)
// doesn't replay each active session's entire lifetime cost as one fake spike on the next turn.

export interface UsageLedgerEntry {
  model: string;
  costUsd: number;
  at: number;
}

export interface ModelBreakdown {
  model: string;
  costUsd: number;
  share: number;
}

export interface UsageBreakdown {
  windowMs: number;
  perModel: ModelBreakdown[];
  burnRatePerHour: number;
  estimatedRunwayMs: number | null;
}

interface LastSeen {
  costUsd: number;
  at: number;
}

interface Persisted {
  entries?: UsageLedgerEntry[];
  lastSeen?: Record<string, LastSeen>;
}

// Session bookkeeping (lastSeen) is dropped once a session goes quiet this long — bounds
// the map's growth across the churn of many short-lived sessions. Independent of how long
// ledger *entries* themselves are retained (MAX_ENTRY_AGE_MS, below).
const STALE_SESSION_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRY_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const BURN_RATE_WINDOW_MS = 60 * 60 * 1000;
const BURN_RATE_MIN_ELAPSED_MS = 60 * 1000; // floor so a handful of turns in the first minute don't read as a huge $/hr rate

function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export class UsageLedger {
  private entries: UsageLedgerEntry[] = [];
  private lastSeen = new Map<string, LastSeen>();

  constructor(
    private readonly path: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!existsSync(path)) return;
    let parsed: Persisted;
    try { parsed = JSON.parse(readFileSync(path, 'utf8')) as Persisted; }
    catch { return; }
    this.entries = parsed.entries ?? [];
    this.lastSeen = new Map(Object.entries(parsed.lastSeen ?? {}));
    this.prune();
  }

  record(input: { sessionId: string; model: string; costUsd: number; at?: number }): void {
    if (!Number.isFinite(input.costUsd)) return;
    const at = input.at ?? this.now();
    const prev = this.lastSeen.get(input.sessionId);
    // Negative delta means the cumulative counter went backwards — a session id reused after
    // /clear, or a race with a session restart. Treat the new cumulative value as a fresh start
    // rather than dropping it or recording a negative cost.
    const delta = prev && input.costUsd >= prev.costUsd ? input.costUsd - prev.costUsd : input.costUsd;
    this.lastSeen.set(input.sessionId, { costUsd: input.costUsd, at });
    if (delta > 0) this.entries.push({ model: input.model, costUsd: delta, at });
    this.prune();
    this.persist();
  }

  breakdown(windowMs: number, accountUsage?: AccountUsageSnapshot): UsageBreakdown {
    const now = this.now();
    const inWindow = this.entries.filter((e) => e.at >= now - windowMs && e.at <= now);
    const totalsByModel = new Map<string, number>();
    let total = 0;
    for (const e of inWindow) {
      totalsByModel.set(e.model, (totalsByModel.get(e.model) ?? 0) + e.costUsd);
      total += e.costUsd;
    }
    const perModel: ModelBreakdown[] = [...totalsByModel.entries()]
      .map(([model, costUsd]) => ({ model, costUsd, share: total > 0 ? costUsd / total : 0 }))
      .sort((a, b) => b.costUsd - a.costUsd);

    const burnRatePerHour = this.computeBurnRate(now);
    const estimatedRunwayMs = this.estimateRunway(now, burnRatePerHour, accountUsage);
    return { windowMs, perModel, burnRatePerHour, estimatedRunwayMs };
  }

  private computeBurnRate(now: number): number {
    const cutoff = now - BURN_RATE_WINDOW_MS;
    const inWindow = this.entries.filter((e) => e.at >= cutoff && e.at <= now);
    if (inWindow.length === 0) return 0;
    const sum = inWindow.reduce((acc, e) => acc + e.costUsd, 0);
    const earliest = Math.min(...inWindow.map((e) => e.at));
    const elapsedMs = Math.max(now - earliest, BURN_RATE_MIN_ELAPSED_MS);
    return sum / (elapsedMs / BURN_RATE_WINDOW_MS);
  }

  // Extrapolates from account-wide "% of 5h quota used" against cost actually observed in that
  // same window: impliedCapUsd = spend-so-far / (used% / 100); runway = (cap - spend) / burnRate.
  // This is a heuristic (the real per-account dollar cap isn't exposed anywhere) — it degrades to
  // null (unknown) whenever we don't have enough signal to extrapolate from, rather than guessing.
  private estimateRunway(now: number, burnRatePerHour: number, accountUsage?: AccountUsageSnapshot): number | null {
    const fiveHour = accountUsage?.five_hour;
    if (!fiveHour || fiveHour.used_percentage <= 0 || burnRatePerHour <= 0) return null;
    const spendInWindow = this.entries
      .filter((e) => e.at >= now - 5 * 60 * 60 * 1000 && e.at <= now)
      .reduce((acc, e) => acc + e.costUsd, 0);
    if (spendInWindow <= 0) return null;
    const impliedCapUsd = spendInWindow / (fiveHour.used_percentage / 100);
    const remainingUsd = Math.max(0, impliedCapUsd - spendInWindow);
    let runwayMs = (remainingUsd / burnRatePerHour) * 60 * 60 * 1000;
    if (fiveHour.resets_at) {
      const msUntilReset = fiveHour.resets_at * 1000 - now;
      if (msUntilReset > 0) runwayMs = Math.min(runwayMs, msUntilReset);
    }
    return Math.max(0, runwayMs);
  }

  private prune(): void {
    const cutoff = this.now() - MAX_ENTRY_AGE_MS;
    this.entries = this.entries.filter((e) => e.at >= cutoff);
    const staleCutoff = this.now() - STALE_SESSION_MS;
    for (const [sessionId, seen] of this.lastSeen) {
      if (seen.at < staleCutoff) this.lastSeen.delete(sessionId);
    }
  }

  private persist(): void {
    const out: Persisted = {
      entries: this.entries,
      lastSeen: Object.fromEntries(this.lastSeen),
    };
    atomicWrite(this.path, JSON.stringify(out) + '\n');
  }
}
