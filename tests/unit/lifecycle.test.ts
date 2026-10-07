import { describe, it, expect } from 'vitest';
import { decideJobTransitions, owesStepReview } from '../../src/jobs/lifecycle.js';
import type { JobRecord, Step } from '../../src/work/work-types.js';

function actionStep(id: string, over: Partial<Step> = {}): Step {
  return {
    id, type: 'action', action: 'read.investigate', title: id, description: '',
    goal: '', state: 'resolved', workspace: { kind: 'none' },
    createdAt: 1, updatedAt: 1, ...over,
  } as Step;
}
function job(steps: Step[], over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'j', source: 'manual', title: 't', description: 'd', state: 'executing',
    steps, createdAt: 1, updatedAt: 1, ...over,
  } as JobRecord;
}

describe('owesStepReview', () => {
  it('returns the step id of a settled, unreviewed solo group', () => {
    expect(owesStepReview(job([actionStep('a')]))).toBe('a');
  });

  it('returns null once the settled group is marked reviewed', () => {
    expect(owesStepReview(job([actionStep('a', { reviewed: true })]))).toBeNull();
  });

  it('returns null while a sibling in the same parallel group is still running', () => {
    const steps = [
      actionStep('a', { parallelGroup: 'g1' }),
      actionStep('b', { parallelGroup: 'g1', state: 'running' }),
    ];
    expect(owesStepReview(job(steps))).toBeNull();
  });

  it('advances to a later settled+unreviewed group after the first is reviewed', () => {
    const steps = [actionStep('a', { reviewed: true }), actionStep('b')];
    expect(owesStepReview(job(steps))).toBe('b');
  });

  it('returns null when any step has a failure (job halts instead)', () => {
    const steps = [actionStep('a'), actionStep('b', { failure: { reason: 'x', at: 1 } })];
    expect(owesStepReview(job(steps))).toBeNull();
  });

  it('returns null when the job is not executing', () => {
    expect(owesStepReview(job([actionStep('a')], { state: 'planning' }))).toBeNull();
  });

  it('skips cancelled members and reviews the group on its live member', () => {
    const steps = [
      actionStep('a', { parallelGroup: 'g1', cancelled: true }),
      actionStep('b', { parallelGroup: 'g1' }),
    ];
    expect(owesStepReview(job(steps))).toBe('b');
  });
});

describe('decideJobTransitions (post-overhaul)', () => {
  it('marks done when all steps resolved (no auto-replan gate)', () => {
    const t = decideJobTransitions(job([actionStep('a'), actionStep('b')]));
    expect(t.some((x) => x.kind === 'mark-done')).toBe(true);
    expect(t.some((x) => (x as { kind: string }).kind === 'auto-replan')).toBe(false);
  });

  it('marks failed when a step failed', () => {
    const steps = [actionStep('a', { failure: { reason: 'x', at: 1 } })];
    expect(decideJobTransitions(job(steps))).toEqual([{ kind: 'mark-failed' }]);
  });

  // mark-done lands before mark-linear-state in the same batch, so a throw on the
  // Linear call leaves an already-done job owing the write. Re-emitting for `done`
  // is the only thing that makes the retry-next-tick path reachable.
  it('re-emits the Linear done-write for an already-done job that never got one', () => {
    const j = job([actionStep('a')], {
      state: 'done', source: 'linear', externalRef: { url: 'https://linear.app/x', linearUuid: 'u' },
    });
    expect(decideJobTransitions(j)).toEqual([{ kind: 'mark-linear-state', state: 'done' }]);
  });

  it('emits nothing for a done job whose Linear state already landed', () => {
    const j = job([actionStep('a')], {
      state: 'done', source: 'linear', externalRef: { url: 'https://linear.app/x', linearUuid: 'u' },
      linearStateMarked: { done: true },
    });
    expect(decideJobTransitions(j)).toEqual([]);
  });

  it('emits nothing for terminal jobs that owe Linear nothing', () => {
    for (const state of ['done', 'failed', 'abandoned'] as const) {
      expect(decideJobTransitions(job([actionStep('a')], { state }))).toEqual([]);
    }
  });
});

describe('decideJobTransitions — PR links on the Linear ticket', () => {
  const URL_A = 'https://github.com/o/r/pull/1';
  const URL_B = 'https://github.com/o/r/pull/2';
  function prStep(id: string, prUrl: string | undefined, over: Record<string, unknown> = {}): Step {
    return {
      id, type: 'orchestrated', controller: 'code.orchestrate-pr', title: id, description: '', goal: '',
      state: 'waiting', workspace: { kind: 'writable', repoCwd: '/r', branch: id },
      dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
      ...(prUrl ? { pr: { prUrl, prState: 'open' } } : {}),
      createdAt: 1, updatedAt: 1, ...over,
    } as Step;
  }
  const linear = { source: 'linear' as const, externalRef: { linearUuid: 'uuid-1' } } as Partial<JobRecord>;
  const links = (j: JobRecord) => decideJobTransitions(j).filter((t) => t.kind === 'link-linear-pr');

  it('links every PR a writable step opened, once', () => {
    const j = job([prStep('a', URL_A), prStep('b', URL_B), prStep('c', undefined)], linear);
    expect(links(j)).toEqual([
      { kind: 'link-linear-pr', prUrl: URL_A },
      { kind: 'link-linear-pr', prUrl: URL_B },
    ]);
    expect(links({ ...j, linearLinkedPrs: [URL_A] })).toEqual([{ kind: 'link-linear-pr', prUrl: URL_B }]);
  });

  // What the hourly intake script actually writes: no UUID, only the identifier.
  it('works from the issue identifier alone', () => {
    const j = job([prStep('a', URL_A)], { source: 'linear', externalRef: { url: 'u', issueIdentifier: 'CLT-1' } });
    expect(links(j)).toEqual([{ kind: 'link-linear-pr', prUrl: URL_A }]);
    expect(decideJobTransitions(j)).toContainEqual({ kind: 'mark-linear-state', state: 'inProgress' });
  });

  it("skips a review step's PR, a cancelled step, and a job not from Linear", () => {
    const review = prStep('a', URL_A, { workspace: { kind: 'readonly', repoCwd: '/r' } });
    expect(links(job([review], linear))).toEqual([]);
    expect(links(job([prStep('a', URL_A, { cancelled: true })], linear))).toEqual([]);
    expect(links(job([prStep('a', URL_A)]))).toEqual([]);
  });

  it('still links on a failed or done job, never on an abandoned one', () => {
    const steps = [prStep('a', URL_A)];
    expect(links(job(steps, { ...linear, state: 'failed' }))).toHaveLength(1);
    expect(links(job(steps, { ...linear, state: 'done', linearStateMarked: { done: true } }))).toHaveLength(1);
    expect(links(job(steps, { ...linear, state: 'abandoned' }))).toEqual([]);
  });
});
