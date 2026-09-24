import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { JobRecord, OrchestratedStep, PrFacts } from '../../src/work/work-types.js';

// The watcher re-reads every live PR on every sweep and applies what it read whether or not
// anything moved. Stamping updatedAt for that made an idle PR read as activity: a review step
// untouched for six weeks sat at the top of the tracked list (sorted by updatedAt) showing
// "2m ago", because the sweep that learned nothing had just rewritten it.

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'engine-pr-facts-'));
  const queue = new JobQueue(dir);
  const engine = new WorkEngine({
    queue,
    sessionManager: { spawnDetached() {}, send() {}, isWorking() { return false; }, sendOrResume() {} } as never,
    worktreeManager: { provision: async () => ({ path: dir }) } as never,
    linearWriter: { setState: async () => undefined } as never,
    actionsStore: {} as never,
    actionRegistry: { getAction: () => ({ frontmatter: { outpost: { runner: 'claude' } } }) } as never,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 5000,
  });
  return { engine, queue };
}

const SEEDED_AT = 1;

const FACTS: PrFacts = {
  prUrl: 'https://github.com/o/r/pull/1',
  prState: 'open',
  headRefOid: 'a'.repeat(40),
  ciChecks: [{ name: 'build', state: 'success' }],
  ciState: 'success',
};

// JobQueue.mutate bumps updatedAt to the wall clock unless the mutator overrides it to
// something other than the current value — hence the sentinel, which also keeps "did this
// write bump it" off a same-millisecond comparison against the seed.
function seed(queue: JobQueue, engine: WorkEngine): { jobId: string; stepId: string } {
  const step: OrchestratedStep = {
    id: 's1', type: 'orchestrated', title: 't', description: 'd', goal: 'g',
    controller: 'code.orchestrate-review', workspace: { kind: 'readonly', repoCwd: '/tmp/repo' },
    dispatches: [], inbox: [], roundsSpent: 2, consecutiveSelfRounds: 0,
    state: 'waiting', pr: { ...FACTS }, createdAt: 1000, updatedAt: 1000,
  };
  const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
  queue.mutate(job.id, (j): JobRecord => ({ ...j, state: 'executing', steps: [step], updatedAt: SEEDED_AT }));
  return { jobId: job.id, stepId: step.id };
}

describe('WorkEngine.applyPrFacts', () => {
  it('does not count a sweep that learned nothing as activity', () => {
    const { engine, queue } = makeEngine();
    const { jobId, stepId } = seed(queue, engine);

    engine.applyPrFacts(jobId, stepId, { ...FACTS, ciChecks: [{ name: 'build', state: 'success' }] });

    const job = queue.get(jobId)!;
    expect(job.updatedAt).toBe(SEEDED_AT);
    expect(job.steps[0]!.updatedAt).toBe(1000);
    expect(job.linearStatusDirty).toBeFalsy();
  });

  it('records a sweep that learned something', () => {
    const { engine, queue } = makeEngine();
    const { jobId, stepId } = seed(queue, engine);

    engine.applyPrFacts(jobId, stepId, { ...FACTS, ciState: 'failure' });

    const job = queue.get(jobId)!;
    expect(job.updatedAt).toBeGreaterThan(SEEDED_AT);
    expect(job.steps[0]!.updatedAt).toBe(5000);
    expect((job.steps[0] as OrchestratedStep).pr?.ciState).toBe('failure');
    expect(job.linearStatusDirty).toBe(true);
  });

  it('records a pruned iteration even when the facts are unchanged', () => {
    const { engine, queue } = makeEngine();
    const { jobId, stepId } = seed(queue, engine);

    engine.applyPrFacts(jobId, stepId, { ...FACTS }, []);

    const job = queue.get(jobId)!;
    expect(job.updatedAt).toBeGreaterThan(SEEDED_AT);
    expect((job.steps[0] as OrchestratedStep).iterations).toEqual([]);
  });
});
