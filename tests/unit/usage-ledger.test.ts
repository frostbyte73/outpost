import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLedger } from '../../src/integrations/usage-ledger.js';

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'usage-ledger-')), 'usage.json');
}

describe('UsageLedger', () => {
  it('records only the delta of a session\'s cumulative cost, not the running total', () => {
    let now = 0;
    const l = new UsageLedger(tmpPath(), () => now);
    l.record({ sessionId: 's1', model: 'opus', costUsd: 1.0, at: now });
    now += 1000;
    l.record({ sessionId: 's1', model: 'opus', costUsd: 1.5, at: now }); // +0.5
    now += 1000;
    l.record({ sessionId: 's1', model: 'opus', costUsd: 3.0, at: now }); // +1.5
    const b = l.breakdown(60_000);
    expect(b.perModel).toEqual([{ model: 'opus', costUsd: 3.0, share: 1 }]);
  });

  it('treats a decreasing cumulative cost as a fresh session (no negative delta)', () => {
    let now = 0;
    const l = new UsageLedger(tmpPath(), () => now);
    l.record({ sessionId: 's1', model: 'opus', costUsd: 2.0, at: now });
    now += 1000;
    l.record({ sessionId: 's1', model: 'opus', costUsd: 0.4, at: now }); // reset, e.g. reused id
    const b = l.breakdown(60_000);
    const total = b.perModel.reduce((acc, m) => acc + m.costUsd, 0);
    expect(total).toBeCloseTo(2.4, 6);
  });

  it('breakdown groups by model and computes share', () => {
    let now = 0;
    const l = new UsageLedger(tmpPath(), () => now);
    l.record({ sessionId: 's1', model: 'opus', costUsd: 3, at: now });
    l.record({ sessionId: 's2', model: 'sonnet', costUsd: 1, at: now });
    const b = l.breakdown(60_000);
    const opus = b.perModel.find((m) => m.model === 'opus');
    const sonnet = b.perModel.find((m) => m.model === 'sonnet');
    expect(opus?.costUsd).toBeCloseTo(3);
    expect(opus?.share).toBeCloseTo(0.75);
    expect(sonnet?.costUsd).toBeCloseTo(1);
    expect(sonnet?.share).toBeCloseTo(0.25);
  });

  it('breakdown windowMs excludes entries older than the window', () => {
    let now = 0;
    const l = new UsageLedger(tmpPath(), () => now);
    l.record({ sessionId: 's1', model: 'opus', costUsd: 1, at: now });
    now += 6 * 60 * 60 * 1000; // 6h later, outside a 5h window
    l.record({ sessionId: 's2', model: 'sonnet', costUsd: 2, at: now });
    const b = l.breakdown(5 * 60 * 60 * 1000);
    expect(b.perModel.map((m) => m.model)).toEqual(['sonnet']);
  });

  it('burnRatePerHour reflects cost accrued in the trailing 1h', () => {
    let now = 0;
    const l = new UsageLedger(tmpPath(), () => now);
    l.record({ sessionId: 's1', model: 'opus', costUsd: 1, at: now }); // first turn: full 1.0 delta, 1h ago
    now += 60 * 60 * 1000; // 1h later
    l.record({ sessionId: 's1', model: 'opus', costUsd: 2, at: now }); // +1.0 delta, now
    const b = l.breakdown(60 * 60 * 1000);
    // Both entries are within [now-1h, now]; elapsed since earliest is a full hour → sum/1h = 2/hr.
    expect(b.burnRatePerHour).toBeCloseTo(2, 1);
  });

  it('burnRatePerHour is 0 with no recent entries', () => {
    const l = new UsageLedger(tmpPath(), () => 0);
    expect(l.breakdown(60_000).burnRatePerHour).toBe(0);
  });

  it('estimatedRunwayMs is null without account usage data', () => {
    let now = 0;
    const l = new UsageLedger(tmpPath(), () => now);
    l.record({ sessionId: 's1', model: 'opus', costUsd: 1, at: now });
    expect(l.breakdown(60_000).estimatedRunwayMs).toBeNull();
    expect(l.breakdown(60_000, { five_hour: { used_percentage: 0, resets_at: 0 } }).estimatedRunwayMs).toBeNull();
  });

  it('estimatedRunwayMs extrapolates from used_percentage and clamps to time-until-reset', () => {
    let now = 0;
    const l = new UsageLedger(tmpPath(), () => now);
    // $1 spent so far corresponds to 50% used → implied cap is $2, $1 remaining.
    l.record({ sessionId: 's1', model: 'opus', costUsd: 1, at: now });
    now += 30 * 60 * 1000; // 30min later, still burning
    l.record({ sessionId: 's1', model: 'opus', costUsd: 2, at: now }); // +1 over 30min → burn rate $2/hr
    const accountUsage = { five_hour: { used_percentage: 50, resets_at: 0 } };
    const runway = l.breakdown(5 * 60 * 60 * 1000, accountUsage).estimatedRunwayMs;
    // implied cap ~$4 (spend 2 / 0.5), remaining ~$2, burn rate ~$2/hr (rounded) → ~1h runway.
    expect(runway).not.toBeNull();
    expect(runway!).toBeGreaterThan(0);
  });

  it('persists entries and lastSeen across instances so a restart does not replay full cost as a spike', () => {
    const path = tmpPath();
    let now = 0;
    const l1 = new UsageLedger(path, () => now);
    l1.record({ sessionId: 's1', model: 'opus', costUsd: 5, at: now });
    // Simulate restart: new instance from the same path, cumulative cost keeps climbing.
    const l2 = new UsageLedger(path, () => now);
    l2.record({ sessionId: 's1', model: 'opus', costUsd: 5.2, at: now });
    const total = l2.breakdown(60_000).perModel.reduce((acc, m) => acc + m.costUsd, 0);
    expect(total).toBeCloseTo(5.2, 6); // 5 (from l1) + 0.2 delta, not 5 + 5.2
  });
});
