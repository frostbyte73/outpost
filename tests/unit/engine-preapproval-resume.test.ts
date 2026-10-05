import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { JobRecord, OrchestratedStep } from '../../src/work/work-types.js';

// The controller that raised a draft is still inside the turn that called submit_write_draft
// when a pre-approval accepts it. The resume is the same one a manual Accept sends: the CLI
// queues it behind the live turn, and owedStaleStops keeps that turn's Stop from failing the step.

describe('an auto-approval raised mid-turn', () => {
  it('resumes the controller for its commit phase without failing the live step', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-preapproval-'));
    const queue = new JobQueue(dir);
    const sends: string[] = [];
    const engine = new WorkEngine({
      queue,
      sessionManager: {
        spawnDetached() {}, isWorking() { return true; },
        send(id: string) { sends.push(id); }, sendOrResume(id: string) { sends.push(id); },
      } as never,
      worktreeManager: { provision: async () => ({ path: dir }), get: () => undefined } as never,
      linearWriter: { setState: async () => undefined } as never,
      actionsStore: {} as never,
      actionRegistry: { getAction: () => undefined, gatedFor: () => undefined, listActions: () => [] } as never,
      jobsDir: join(dir, 'jobs'),
      newId: (() => { let n = 0; return () => `id-${++n}`; })(),
      now: () => 1000,
    });
    const step: OrchestratedStep = {
      id: 's1', type: 'orchestrated', title: 't', description: 'd', controller: 'code.orchestrate-pr', goal: 'g',
      workspace: { kind: 'writable', repoCwd: dir, branch: 'deps/x' }, baseBranch: 'main',
      dispatches: [], inbox: [], roundsSpent: 1, consecutiveSelfRounds: 0,
      state: 'running', sessionId: 'sess1', createdAt: 1000, updatedAt: 1000,
    };
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    queue.mutate(job.id, (j): JobRecord => ({ ...j, state: 'executing', steps: [step], preapprovals: { push: true } }));
    engine.rehydrateSessionBindings();

    const res = await engine.onWriteDraftReady(job.id, 's1', {
      action: 'code.orchestrate-pr', raisedBy: { kind: 'controller' }, summary: 'push',
      calls: [{ id: 'c1', bash: 'git push -u origin deps/x' }],
    });

    expect(res).toEqual({ ok: true, autoApproved: true });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    const after = queue.get(job.id)!.steps[0] as OrchestratedStep;
    expect(sends).toEqual(['sess1']);
    expect(after.failure).toBeUndefined();
    expect(after.state).toBe('running');
    expect(after.drafts![0]!.approvedBy).toBe('preapproval');
  });
});
