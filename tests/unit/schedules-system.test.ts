import { describe, it, expect } from 'vitest';
import { SystemScheduleRegistry, type SystemPoller } from '../../src/schedules/system-schedules.js';

function fakePoller(over: Partial<SystemPoller> & { id: string }): SystemPoller {
  return {
    name: over.id,
    intervalMs: 60_000,
    status: () => ({ lastRunAt: null, lastError: null, running: false }),
    runNow: () => Promise.resolve(),
    ...over,
  };
}

describe('SystemScheduleRegistry', () => {
  it('computes nextRunAt from lastRunAt + intervalMs', () => {
    const reg = new SystemScheduleRegistry();
    reg.register(fakePoller({ id: 'linear', intervalMs: 1000, status: () => ({ lastRunAt: 5000, lastError: null, running: false }) }));
    const d = reg.list()[0]!;
    expect(d.nextRunAt).toBe(6000);
    expect(d.kind).toBe('system');
  });

  it('leaves nextRunAt null for an adaptive poller (intervalMs null)', () => {
    const reg = new SystemScheduleRegistry();
    reg.register(fakePoller({ id: 'usage', intervalMs: null, status: () => ({ lastRunAt: 5000, lastError: null, running: false }) }));
    expect(reg.list()[0]!.nextRunAt).toBeNull();
  });

  it('leaves nextRunAt null when the poller has never run', () => {
    const reg = new SystemScheduleRegistry();
    reg.register(fakePoller({ id: 'pr', intervalMs: 1000 }));
    expect(reg.list()[0]!.nextRunAt).toBeNull();
  });

  it('runNow triggers the poller and returns the refreshed descriptor', async () => {
    let ran = false;
    const reg = new SystemScheduleRegistry();
    reg.register(fakePoller({ id: 'linear', runNow: () => { ran = true; return Promise.resolve(); } }));
    const d = await reg.runNow('linear');
    expect(ran).toBe(true);
    expect(d?.id).toBe('linear');
  });

  it('runNow swallows a poller error and surfaces it via lastError', async () => {
    const reg = new SystemScheduleRegistry();
    let err: string | null = null;
    reg.register(fakePoller({
      id: 'linear',
      runNow: () => { err = 'boom'; return Promise.reject(new Error('boom')); },
      status: () => ({ lastRunAt: 1, lastError: err, running: false }),
    }));
    const d = await reg.runNow('linear');
    expect(d?.lastError).toBe('boom');
  });

  it('runNow returns null for an unknown poller', async () => {
    const reg = new SystemScheduleRegistry();
    expect(await reg.runNow('nope')).toBeNull();
  });
});
