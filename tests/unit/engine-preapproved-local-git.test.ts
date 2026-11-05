import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import { Allowlist } from '../../src/permissions/allowlist.js';
import type { JobRecord, OrchestratedStep, Preapprovals } from '../../src/work/work-types.js';

const ACTION = 'code.orchestrate-pr';
const emptyCfg = { alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [] };

function setup(stepPre: Preapprovals | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'engine-local-git-'));
  const queue = new JobQueue(dir);
  const engine = new WorkEngine({
    queue,
    sessionManager: { spawnDetached() {}, isWorking() { return false; }, send() {}, sendOrResume() {} } as never,
    worktreeManager: { provision: async () => ({ path: dir }), get: () => undefined } as never,
    linearWriter: { setState: async () => undefined } as never,
    actionsStore: {} as never,
    actionRegistry: { getAction: () => undefined, gatedFor: () => undefined, listActions: () => [] } as never,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 1000,
  });
  const step: OrchestratedStep = {
    id: 's1', type: 'orchestrated', title: 't', description: 'd', controller: ACTION, goal: 'g',
    workspace: { kind: 'writable', repoCwd: dir, branch: 'feat/x' }, baseBranch: 'main',
    dispatches: [{ id: 'd1', action: 'code.review-diff', brief: 'b', status: 'running', sessionId: 'child', createdAt: 1000 } as never],
    inbox: [], roundsSpent: 1, consecutiveSelfRounds: 0,
    state: 'running', sessionId: 'ctl', createdAt: 1000, updatedAt: 1000,
    ...(stepPre ? { preapprovals: stepPre } : {}),
  };
  const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
  queue.mutate(job.id, (j): JobRecord => ({ ...j, state: 'executing', steps: [step] }));
  engine.rehydrateSessionBindings();
  const allowlist = new Allowlist(emptyCfg, { preapprovedFor: (id) => engine.preapprovedRulesFor(id) });
  const allows = (cmd: string, session = 'ctl') => allowlist.allows('Bash', { command: cmd }, undefined, ACTION, undefined, session);
  return { allows, queue, jobId: job.id };
}

describe('local git granted by the push pre-approval', () => {
  it('stages for the controller only while push is pre-approved', () => {
    const { allows, queue, jobId } = setup({ push: true });
    expect(allows('git add -A')).toBe(true);
    expect(allows('git add -A && rm -rf src')).toBe(false);
    expect(allows('git rebase origin/main')).toBe(false);

    queue.mutate(jobId, (j) => ({ ...j, steps: j.steps.map((s) => ({ ...s, preapprovals: { push: false } })) as JobRecord['steps'] }));
    expect(allows('git add -A')).toBe(false);
  });

  it('adds the rebase onto the base branch for a direct landing', () => {
    const { allows } = setup({ push: true, landing: 'direct' });
    expect(allows('git rebase origin/main')).toBe(true);
    expect(allows('git rebase origin/other')).toBe(false);
  });

  it('grants nothing without push, or to a dispatched child', () => {
    expect(setup({ landing: 'direct' }).allows('git add -A')).toBe(false);
    expect(setup({ push: true }).allows('git add -A', 'child')).toBe(false);
  });
});
