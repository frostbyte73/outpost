import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchedulesStore, type CreateScheduleInput } from '../../src/schedules/schedules-store.js';

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'sched-store-')), 'index.json');
}

function input(overrides: Partial<CreateScheduleInput> = {}): CreateScheduleInput {
  return {
    name: 'Nightly triage',
    enabled: true,
    trigger: { kind: 'cron', expr: '0 2 * * *' },
    what: { kind: 'skill', skill: 'read.investigate', repos: ['acme/web'] },
    guards: [],
    routing: {},
    ...overrides,
  };
}

describe('SchedulesStore', () => {
  it('round-trips schedules across instances', () => {
    const path = tmpPath();
    const s1 = new SchedulesStore(path);
    const created = s1.create(input());
    const s2 = new SchedulesStore(path);
    expect(s2.get(created.id)).toEqual(created);
    expect(s2.list()).toHaveLength(1);
  });

  it('update bumps updatedAt and merges fields', () => {
    const s = new SchedulesStore(tmpPath());
    const created = s.create(input());
    const updated = s.update(created.id, { enabled: false, name: 'Renamed' });
    expect(updated?.enabled).toBe(false);
    expect(updated?.name).toBe('Renamed');
    expect(updated?.createdAt).toBe(created.createdAt);
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
  });

  it('update on unknown id returns null', () => {
    const s = new SchedulesStore(tmpPath());
    expect(s.update('nope', { enabled: false })).toBeNull();
  });

  it('duplicate copies trigger/what/guards/routing, starts paused, gets a new id and name', () => {
    const s = new SchedulesStore(tmpPath());
    const created = s.create(input({ enabled: true, name: 'Original' }));
    const dup = s.duplicate(created.id);
    expect(dup).not.toBeNull();
    expect(dup!.id).not.toBe(created.id);
    expect(dup!.name).toBe('Original copy');
    expect(dup!.enabled).toBe(false);
    expect(dup!.trigger).toEqual(created.trigger);
    expect(dup!.what).toEqual(created.what);
    expect(s.list()).toHaveLength(2);
  });

  it('duplicate of unknown id returns null', () => {
    const s = new SchedulesStore(tmpPath());
    expect(s.duplicate('nope')).toBeNull();
  });

  it('remove deletes the schedule and its runs', () => {
    const s = new SchedulesStore(tmpPath());
    const created = s.create(input());
    s.startRun(created.id, { outcome: 'running' });
    expect(s.remove(created.id)).toBe(true);
    expect(s.get(created.id)).toBeUndefined();
    expect(s.listRuns(created.id)).toHaveLength(0);
    expect(s.remove(created.id)).toBe(false);
  });

  it('startRun + updateRun + listRuns (most-recent first)', () => {
    const s = new SchedulesStore(tmpPath());
    const created = s.create(input());
    const r1 = s.startRun(created.id, { outcome: 'running', startedAt: 100 })!;
    const r2 = s.startRun(created.id, { outcome: 'running', startedAt: 200 })!;
    s.updateRun(r1.id, { outcome: 'ok', finishedAt: 150 });
    const runs = s.listRuns(created.id);
    expect(runs.map((r) => r.id)).toEqual([r2.id, r1.id]);
    expect(runs[1]!.outcome).toBe('ok');
  });

  it('listRuns respects a limit', () => {
    const s = new SchedulesStore(tmpPath());
    const created = s.create(input());
    for (let i = 0; i < 5; i++) s.startRun(created.id, { outcome: 'ok', startedAt: i });
    expect(s.listRuns(created.id, 2)).toHaveLength(2);
  });

  it('bounds run retention per schedule', () => {
    const s = new SchedulesStore(tmpPath());
    const created = s.create(input());
    for (let i = 0; i < 205; i++) s.startRun(created.id, { outcome: 'ok', startedAt: i });
    expect(s.listRuns(created.id).length).toBeLessThanOrEqual(200);
  });

  it('findRunByRef matches on jobId or sessionId', () => {
    const s = new SchedulesStore(tmpPath());
    const created = s.create(input());
    const run = s.startRun(created.id, { outcome: 'running', refs: { jobId: 'job-1' } })!;
    expect(s.findRunByRef({ jobId: 'job-1' })?.id).toBe(run.id);
    expect(s.findRunByRef({ sessionId: 'nope' })).toBeUndefined();
  });

  it('lastRun can exclude skipped runs', () => {
    const s = new SchedulesStore(tmpPath());
    const created = s.create(input());
    s.startRun(created.id, { outcome: 'ok', startedAt: 100 });
    s.startRun(created.id, { outcome: 'skipped', startedAt: 200, skipReason: 'paused' });
    expect(s.lastRun(created.id)?.startedAt).toBe(200);
    expect(s.lastRun(created.id, { excludeSkipped: true })?.startedAt).toBe(100);
  });

  it('startRun refuses to create a run for a deleted/unknown scheduleId', () => {
    const s = new SchedulesStore(tmpPath());
    const created = s.create(input());
    s.remove(created.id);
    expect(s.startRun(created.id, { outcome: 'running' })).toBeNull();
    expect(s.listRuns(created.id)).toHaveLength(0);
  });

  it('normalizes a legacy kind-less `what` to a skill schedule on read', () => {
    const path = tmpPath();
    writeFileSync(path, JSON.stringify({
      schedules: [{
        id: 'legacy', name: 'Old', enabled: true,
        trigger: { kind: 'cron', expr: '0 0 * * *' },
        what: { skill: 'read.investigate', repos: ['acme/web'] },
        guards: [], routing: {}, createdAt: 1, updatedAt: 1,
      }],
    }));
    const s = new SchedulesStore(path);
    expect(s.get('legacy')?.what).toEqual({ kind: 'skill', skill: 'read.investigate', repos: ['acme/web'] });
  });

  it('persists prompt and script schedules', () => {
    const s = new SchedulesStore(tmpPath());
    const prompt = s.create(input({ what: { kind: 'prompt', prompt: 'summarize PRs', cwd: '/repo' } }));
    const script = s.create(input({ what: { kind: 'script', script: 'npm test', cwd: '/repo' } }));
    expect(prompt.what).toEqual({ kind: 'prompt', prompt: 'summarize PRs', cwd: '/repo' });
    expect(script.what).toEqual({ kind: 'script', script: 'npm test', cwd: '/repo' });
  });

  it('starts empty on malformed json', () => {
    const path = tmpPath();
    writeFileSync(path, '{not json');
    const s = new SchedulesStore(path);
    expect(s.list()).toEqual([]);
  });
});
