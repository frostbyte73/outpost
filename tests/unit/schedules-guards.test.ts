import { describe, it, expect } from 'vitest';
import { evaluateGuards, type GuardProviders } from '../../src/schedules/guards.js';
import type { Guard, ScheduleRecord } from '../../src/schedules/types.js';

function schedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: 's1',
    name: 'Test',
    enabled: true,
    trigger: { kind: 'cron', expr: '0 0 * * *' },
    what: { kind: 'skill', skill: 'read.investigate', repos: ['acme/web'] },
    guards: [],
    routing: {},
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function providers(overrides: Partial<GuardProviders> = {}): GuardProviders {
  return {
    getUsageSnapshot: () => undefined,
    getRepoLastChange: () => null,
    ...overrides,
  };
}

describe('evaluateGuards — usage-threshold', () => {
  it('skips when usage exceeds the threshold', async () => {
    const guard: Guard = { kind: 'usage-threshold', window: '7d', op: '>', value: 90 };
    const result = await evaluateGuards(
      [guard],
      { schedule: schedule() },
      providers({ getUsageSnapshot: () => ({ seven_day: { used_percentage: 96 } }) }),
    );
    expect(result).toEqual({ ok: false, reason: 'Skipped — 7d usage was at 96%' });
  });

  it('passes when usage is below the threshold', async () => {
    const guard: Guard = { kind: 'usage-threshold', window: '7d', op: '>', value: 90 };
    const result = await evaluateGuards(
      [guard],
      { schedule: schedule() },
      providers({ getUsageSnapshot: () => ({ seven_day: { used_percentage: 50 } }) }),
    );
    expect(result).toEqual({ ok: true });
  });

  it('respects >= vs >', async () => {
    const guard: Guard = { kind: 'usage-threshold', window: '5h', op: '>=', value: 90 };
    const result = await evaluateGuards(
      [guard],
      { schedule: schedule() },
      providers({ getUsageSnapshot: () => ({ five_hour: { used_percentage: 90 } }) }),
    );
    expect(result.ok).toBe(false);
  });

  it('fails open when usage data is unavailable', async () => {
    const guard: Guard = { kind: 'usage-threshold', window: '7d', op: '>', value: 90 };
    const result = await evaluateGuards([guard], { schedule: schedule() }, providers());
    expect(result).toEqual({ ok: true });
  });
});

describe('evaluateGuards — no-repo-changes', () => {
  it('passes on a first run (no lastRunAt to compare against)', async () => {
    const guard: Guard = { kind: 'no-repo-changes' };
    const result = await evaluateGuards([guard], { schedule: schedule() }, providers({ getRepoLastChange: () => 500 }));
    expect(result).toEqual({ ok: true });
  });

  it('skips when the repo has not changed since the last run', async () => {
    const guard: Guard = { kind: 'no-repo-changes' };
    const result = await evaluateGuards(
      [guard],
      { schedule: schedule(), lastRunAt: 1000 },
      providers({ getRepoLastChange: () => 900 }),
    );
    expect(result).toEqual({ ok: false, reason: 'Skipped — no changes in acme/web since last run' });
  });

  it('passes when the repo changed after the last run', async () => {
    const guard: Guard = { kind: 'no-repo-changes' };
    const result = await evaluateGuards(
      [guard],
      { schedule: schedule(), lastRunAt: 1000 },
      providers({ getRepoLastChange: () => 1500 }),
    );
    expect(result).toEqual({ ok: true });
  });

  it('fails open when last-change is unknown', async () => {
    const guard: Guard = { kind: 'no-repo-changes' };
    const result = await evaluateGuards(
      [guard],
      { schedule: schedule(), lastRunAt: 1000 },
      providers({ getRepoLastChange: () => null }),
    );
    expect(result).toEqual({ ok: true });
  });

  it('uses the guard-specific repo over the schedule default', async () => {
    const guard: Guard = { kind: 'no-repo-changes', repo: 'acme/infra' };
    const result = await evaluateGuards(
      [guard],
      { schedule: schedule(), lastRunAt: 1000 },
      providers({ getRepoLastChange: () => 900 }),
    );
    expect(result).toEqual({ ok: false, reason: 'Skipped — no changes in acme/infra since last run' });
  });
});

describe('evaluateGuards — combination', () => {
  it('short-circuits on the first failing guard', async () => {
    const guards: Guard[] = [
      { kind: 'usage-threshold', window: '7d', op: '>', value: 90 },
      { kind: 'no-repo-changes' },
    ];
    let secondGuardChecked = false;
    const result = await evaluateGuards(
      guards,
      { schedule: schedule(), lastRunAt: 1000 },
      providers({
        getUsageSnapshot: () => ({ seven_day: { used_percentage: 95 } }),
        getRepoLastChange: () => { secondGuardChecked = true; return 1500; },
      }),
    );
    expect(result.ok).toBe(false);
    expect(secondGuardChecked).toBe(false);
  });

  it('passes when all guards pass', async () => {
    const guards: Guard[] = [
      { kind: 'usage-threshold', window: '7d', op: '>', value: 90 },
      { kind: 'no-repo-changes' },
    ];
    const result = await evaluateGuards(
      guards,
      { schedule: schedule(), lastRunAt: 1000 },
      providers({
        getUsageSnapshot: () => ({ seven_day: { used_percentage: 10 } }),
        getRepoLastChange: () => 2000,
      }),
    );
    expect(result).toEqual({ ok: true });
  });
});
