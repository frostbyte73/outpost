import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { schedulesStore } from '../../src/pwa/state/schedules.js';

const HOURLY = 'sched-hourly';

function stubList(nextRunAt: number) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      schedules: [{ id: HOURLY, name: 'Linear — Assigned Issues', enabled: true, trigger: { kind: 'cron', expr: '0 * * * *' }, nextRunAt }],
    }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('schedules store — WS run events', () => {
  beforeEach(() => stubList(2_000));
  afterEach(() => vi.unstubAllGlobals());

  it('advances nextRunAt from the run event so a fired schedule does not read as overdue', async () => {
    await schedulesStore.load();
    expect(schedulesStore.get().schedules[0].nextRunAt).toBe(2_000);

    schedulesStore.applyWsEvent({
      type: 'schedule_run_changed',
      scheduleId: HOURLY,
      nextRunAt: 5_600_000,
      run: { id: 'run-1', scheduleId: HOURLY, startedAt: 2_000, outcome: 'running' },
    });

    expect(schedulesStore.get().schedules[0].nextRunAt).toBe(5_600_000);
    expect(schedulesStore.get().runsBySchedule.get(HOURLY)).toHaveLength(1);
  });

  it('leaves nextRunAt alone when the event carries none', async () => {
    await schedulesStore.load();
    schedulesStore.applyWsEvent({
      type: 'schedule_run_changed',
      scheduleId: HOURLY,
      run: { id: 'run-2', scheduleId: HOURLY, startedAt: 2_000, outcome: 'running' },
    });
    expect(schedulesStore.get().schedules[0].nextRunAt).toBe(2_000);
  });
});
