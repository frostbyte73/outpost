import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { ProposedStep } from '../../src/work/work-types.js';

// The launch hook snapshots the worktree HEAD, so a fresh session must resolve to its step at spawn.
describe('WorkEngine — fresh step spawn', () => {
  it('binds the session to its step before spawning it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-launch-'));
    const queue = new JobQueue(dir);
    const atSpawn: Array<{ worktree?: string; action?: string }> = [];
    let engine!: WorkEngine;
    const sessionManager = {
      spawnDetached(sessionId: string) {
        atSpawn.push({ worktree: engine.worktreePathForSession(sessionId), action: engine.actionForSession(sessionId) });
      },
      send() {}, isWorking() { return false; }, sendOrResume() {},
    } as never;
    engine = new WorkEngine({
      queue, sessionManager,
      worktreeManager: { get: () => ({ worktreePath: '/wt/step' }), provision: async () => ({ path: '/wt/step' }) } as never,
      linearWriter: { setState: async () => undefined } as never,
      actionsStore: {} as never,
      jobsDir: join(dir, 'jobs'),
      newId: (() => { let n = 0; return () => `id-${++n}`; })(),
      now: () => 1,
    });
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const proposed: ProposedStep = {
      type: 'action', action: 'read.investigate', title: 'Look', description: 'd', goal: 'g',
      workspace: { kind: 'writable', repoCwd: '/tmp', branch: 'feat/x' },
    } as ProposedStep;
    engine.addStepManually(job.id, proposed);
    queue.mutate(job.id, (j) => ({ ...j, state: 'executing' }));
    await engine.tick(job.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(atSpawn).toEqual([{ worktree: '/wt/step', action: 'read.investigate' }]);
  });
});
