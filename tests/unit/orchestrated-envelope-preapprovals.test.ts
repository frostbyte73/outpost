import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { orchestratedHandler } from '../../src/steps/orchestrated.js';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { JobRecord, OrchestratedStep } from '../../src/work/work-types.js';
import type { OrchestratedEnvelope } from '../../src/work/envelope.js';

const step: OrchestratedStep = {
  id: 's1', type: 'orchestrated', title: 't', description: '', controller: 'code.orchestrate-pr', goal: 'g',
  workspace: { kind: 'writable', repoCwd: '/r', branch: 'b' }, baseBranch: 'main',
  preapprovals: { openPr: false }, dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
  state: 'running', createdAt: 0, updatedAt: 0,
};
const job = {
  id: 'j', source: 'manual', title: 't', description: '', state: 'executing', steps: [step],
  preapprovals: { push: true, openPr: true, landing: 'approved' }, createdAt: 0, updatedAt: 0,
} as JobRecord;

describe('the controller envelope', () => {
  it('carries the effective pre-approvals and the base branch', () => {
    const env = orchestratedHandler.buildEnvelope(step, job, { actionRegistry: undefined } as never) as OrchestratedEnvelope;
    expect(env.preapprovals).toEqual({ spec: 'gate', push: true, openPr: false, replies: false, merge: false, landing: 'approved' });
    expect(env.baseBranch).toBe('main');
  });
});

describe('provisioning a controller step', () => {
  it('records the base branch the worktree was cut from', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'base-branch-'));
    const queue = new JobQueue(dir);
    const engine = new WorkEngine({
      queue,
      sessionManager: { spawnDetached() {}, send() {}, isWorking() { return false; }, sendOrResume() {} } as never,
      worktreeManager: { provision: async () => ({ path: dir }), get: () => ({ baseBranch: 'develop' }) } as never,
      linearWriter: { setState: async () => undefined } as never,
      actionsStore: {} as never,
      actionRegistry: { getAction: () => undefined, gatedFor: () => undefined, listActions: () => [] } as never,
      jobsDir: join(dir, 'jobs'),
      newId: (() => { let n = 0; return () => `id-${++n}`; })(),
      now: () => 1000,
    });
    const fresh: OrchestratedStep = { ...step, baseBranch: undefined, workspace: { kind: 'writable', repoCwd: dir, branch: 'b' } };
    const j = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    queue.mutate(j.id, (jj): JobRecord => ({ ...jj, state: 'executing', steps: [fresh] }));
    await engine.tick(j.id);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect((queue.get(j.id)!.steps[0] as OrchestratedStep).baseBranch).toBe('develop');
  });
});
