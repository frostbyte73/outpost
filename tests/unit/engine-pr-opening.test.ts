import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { JobRecord, OrchestratedStep, PrFacts } from '../../src/work/work-types.js';

// When the user hits squash-and-open-PR, the daemon runs `gh pr create` itself and holds the
// URL in its hand — yet `discoverPr`'s `gh pr list` used to be the only thing that ever wrote
// it onto the step, on the 1m escalation at best. For that minute the step's own `pr` said no
// PR existed, which is both what the card showed the user and what row 8 of code.orchestrate-pr
// read before drafting a second `gh pr create`.

const URL = 'https://github.com/livekit/egress/pull/1411';

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'engine-pr-opening-'));
  const queue = new JobQueue(dir);
  const engine = new WorkEngine({
    queue,
    sessionManager: { spawnDetached() {}, send() {}, isWorking() { return false; }, sendOrResume() {} } as never,
    worktreeManager: { provision: async () => ({ path: dir }) } as never,
    linearWriter: { setState: async () => undefined } as never,
    actionsStore: {} as never,
    actionRegistry: { getAction: () => undefined, gatedFor: () => undefined, listActions: () => [] } as never,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 1000,
  });
  return { engine, queue };
}

function seed(engine: WorkEngine, queue: JobQueue, pr?: PrFacts): string {
  const step: OrchestratedStep = {
    id: 's1', type: 'orchestrated', title: 'ship it', description: 'd',
    controller: 'code.orchestrate-pr', goal: 'g',
    workspace: { kind: 'writable', repoCwd: '/tmp/repo', branch: 'fix/thing' },
    dispatches: [], inbox: [], roundsSpent: 4, consecutiveSelfRounds: 0,
    state: 'running', sessionId: 'sess1', createdAt: 1000, updatedAt: 1000, pr,
  };
  const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
  queue.mutate(job.id, (j): JobRecord => ({ ...j, state: 'executing', steps: [step] }));
  engine.rehydrateSessionBindings();
  return job.id;
}

const prOf = (queue: JobQueue, jobId: string) =>
  (queue.get(jobId)!.steps[0] as OrchestratedStep).pr ?? {};

describe('the daemon opening a PR on the user\'s behalf', () => {
  it('records the URL it just opened, without waiting on discovery', () => {
    const { engine, queue } = makeEngine();
    const jobId = seed(engine, queue);

    engine.markPrOpening('sess1');
    expect(prOf(queue, jobId).isOpeningPr).toBe(true);

    engine.finishPrOpening('sess1', URL);

    expect(prOf(queue, jobId)).toMatchObject({ prUrl: URL, prState: 'open', isOpeningPr: false });
  });

  it('clears the flag without inventing a PR when the call failed', () => {
    const { engine, queue } = makeEngine();
    const jobId = seed(engine, queue);

    engine.markPrOpening('sess1');
    engine.finishPrOpening('sess1', undefined);

    expect(prOf(queue, jobId).isOpeningPr).toBe(false);
    expect(prOf(queue, jobId).prUrl).toBeUndefined();
  });

  // Same bar the watcher applies before handing a stored URL to `gh` as an argument: this one
  // is scraped off stdout, so it has no more standing than any other untrusted string.
  it('refuses a url that is not a github PR', () => {
    const { engine, queue } = makeEngine();
    const jobId = seed(engine, queue);

    engine.finishPrOpening('sess1', 'https://evil.example/livekit/egress/pull/1');

    expect(prOf(queue, jobId).prUrl).toBeUndefined();
  });

  it('does not let a flag that outlived a restart silence the branch poll', () => {
    const { engine, queue } = makeEngine();
    const jobId = seed(engine, queue, { isOpeningPr: true });

    engine.reconcileInterruptedSteps();

    expect(prOf(queue, jobId).isOpeningPr).toBe(false);
  });
});
