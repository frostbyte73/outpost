import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEval, newEvalRecord, EvalQueue, type RunEvalDeps } from '../../src/eval/run-eval.js';
import { EvalStore } from '../../src/eval/eval-store.js';
import type { ReplayResult } from '../../src/eval/replay-runner.js';
import type { JudgeOnce } from '../../src/eval/judge.js';
import type { ActionRunRecord } from '../../src/storage/action-runs-store.js';
import type { ActionProposal } from '../../src/storage/action-edits-store.js';
import type { RecordInput } from '../../src/storage/action-revisions-store.js';

let n = 0;
const run = (over: Partial<ActionRunRecord> = {}): ActionRunRecord => ({
  id: `r${++n}`, action: 'code.reply-pr-comments', round: 'draft', attempt: 1, jobId: 'j', stepId: 's',
  startedAt: n, envelopeRef: 'env', outputRef: 'out', skillSha: 'sha', outcome: 'accepted', verdictAt: n, ...over,
});

const proposal = (over: Partial<ActionProposal> = {}): ActionProposal => ({
  summary: 's', skillMdBefore: 'x'.repeat(400), skillMdAfter: 'y'.repeat(380), allowlistAdds: [], postedAt: 100, ...over,
});

const go = (p: ActionProposal, deps: RunEvalDeps) =>
  runEval(deps.store.save(newEvalRecord({ action: 'code.reply-pr-comments', editSessionId: 'es', proposal: p }, 'ev1', 1000)), deps);

// Prefers whichever output came from the candidate (replays return NEW).
const prefersNew: JudgeOnce = async ({ a, b }) => ({ winner: a.includes('NEW') ? 'A' : b.includes('NEW') ? 'B' : 'tie', reason: 'r', costUsd: 0.1 });
const prefersOld: JudgeOnce = async ({ a, b }) => ({ winner: a.includes('NEW') ? 'B' : b.includes('NEW') ? 'A' : 'tie', reason: 'r', costUsd: 0.1 });

function setup(over: Partial<RunEvalDeps> = {}, runs: ActionRunRecord[] = []) {
  const store = new EvalStore(mkdtempSync(join(tmpdir(), 'evals-')));
  const recorded: RecordInput[] = [];
  const replayed: string[] = [];
  const blobs: Record<string, string> = {
    env: '{"goal":"reply"}',
    out: JSON.stringify([{ tool: 'submit_write_draft', args: { summary: 'OLD', calls: [{ bash: 'gh pr comment 1 --body OLD' }] } }]),
  };
  const replay = async (r: ActionRunRecord): Promise<ReplayResult> => {
    replayed.push(r.id);
    return { valid: true, misses: 0, costUsd: 0.5, output: [{ tool: 'submit_write_draft', args: { summary: 'NEW', calls: [{ bash: 'gh pr comment 1 --body NEW' }] } }] };
  };
  const deps: RunEvalDeps = {
    runs: () => runs,
    spent: () => new Set(),
    blob: (r) => blobs[r],
    replay,
    judge: prefersNew,
    store,
    revisions: { record: (i: RecordInput) => { recorded.push(i); return {} as never; } },
    now: () => 1000,
    ...over,
  };
  return { deps, store, recorded, replayed };
}

describe('runEval', () => {
  it('fails a candidate that wins its targets but loses a regression run, and records it', async () => {
    const target = run({ outcome: 'edited', editDiffRef: 'd' });
    const reg = run();
    const judge: JudgeOnce = async (i) => (i.answerKey.startsWith('The user approved this output unchanged') ? prefersOld(i) : prefersNew(i));
    const { deps, recorded, store } = setup({ judge }, [target, reg]);
    const rec = await go(proposal({ citedRunIds: [target.id] }), deps);
    expect(rec.outcome).toBe('fail');
    expect(rec.reasons.join(' ')).toMatch(/regression/);
    expect(store.get('ev1')?.outcome).toBe('fail');
    expect(recorded[0]).toMatchObject({ kind: 'evaluated', author: 'system', evalId: 'ev1' });
  });

  it('passes when the judge prefers the candidate on targets and ties on regression', async () => {
    const target = run({ outcome: 'edited' });
    const reg = run();
    const judge: JudgeOnce = async (i) => (i.answerKey.startsWith('The user approved this output unchanged')
      ? { winner: 'tie', reason: 'same', costUsd: 0.1 }
      : prefersNew(i));
    const { deps } = setup({ judge }, [target, reg]);
    const rec = await go(proposal({ citedRunIds: [target.id] }), deps);
    expect(rec.outcome).toBe('pass');
    expect(rec.replays.map((r) => [r.kind, r.result])).toEqual([['target', 'after'], ['regression', 'tie']]);
    expect(rec.spentUsd).toBeCloseTo(0.5 * 2 + 0.1 * 4);
  });

  it('fails a candidate the judge rejects', async () => {
    const target = run({ outcome: 'revised', feedbackText: 'shorter' });
    const { deps } = setup({ judge: prefersOld }, [target]);
    const rec = await go(proposal({ citedRunIds: [target.id] }), deps);
    expect(rec.outcome).toBe('fail');
  });

  it('does not judge an invalid replay', async () => {
    const target = run({ outcome: 'edited' });
    let judged = 0;
    const { deps } = setup({
      replay: async () => ({ valid: false, misses: 3, costUsd: 0.2, output: [] }),
      judge: async (i) => { judged += 1; return prefersNew(i); },
    }, [target]);
    const rec = await go(proposal({ citedRunIds: [target.id] }), deps);
    expect(judged).toBe(0);
    expect(rec.outcome).toBe('inconclusive');
    expect(rec.replays[0]).toMatchObject({ valid: false, misses: 3 });
  });

  it('stops replaying once the spend cap is reached, and calls an overspend inconclusive', async () => {
    const targets = [run({ outcome: 'edited' }), run({ outcome: 'edited' })];
    const { deps, replayed } = setup({
      capUsd: 1,
      replay: async (r) => { replayed.push(r.id); return { valid: true, misses: 0, costUsd: 1.2, output: [{ tool: 'submit_write_draft', args: { summary: 'NEW' } }] }; },
    }, targets);
    const rec = await go(proposal({ citedRunIds: targets.map((t) => t.id) }), deps);
    expect(replayed).toHaveLength(1);
    expect(rec.outcome).toBe('inconclusive');
  });

  it('treats a judge that throws as an invalid replay', async () => {
    const target = run({ outcome: 'edited' });
    const { deps } = setup({ judge: async () => { throw new Error('ENOENT'); } }, [target]);
    const rec = await go(proposal({ citedRunIds: [target.id] }), deps);
    expect(rec.replays[0]).toMatchObject({ valid: false, error: expect.stringContaining('ENOENT') });
  });
});

describe('shadow agreement', () => {
  it('keeps a user verdict that lands while the eval is running', async () => {
    const target = run({ outcome: 'edited' });
    const reg = run();
    let store!: EvalStore;
    const judge: JudgeOnce = async (i) => {
      store.noteUserVerdict('es', 100, 'approved');
      return i.answerKey.startsWith('The user approved this output unchanged') ? { winner: 'tie', reason: '', costUsd: 0 } : prefersNew(i);
    };
    const f = setup({ judge }, [target, reg]);
    store = f.store;
    await go(proposal({ citedRunIds: [target.id] }), f.deps);
    expect(store.forEdit('es', 100)).toMatchObject({ outcome: 'pass', userVerdict: 'approved', agreed: true });
  });

  it('persists a verdict given before the eval starts, across a reload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evals-'));
    const store = new EvalStore(dir);
    store.save(newEvalRecord({ action: 'a', editSessionId: 'es', proposal: proposal() }, 'ev9', 1));
    store.noteUserVerdict('es', 100, 'rejected');
    const reloaded = new EvalStore(dir);
    expect(reloaded.get('ev9')).toMatchObject({ userVerdict: 'rejected' });
    expect(reloaded.pending().map((r) => r.id)).toEqual(['ev9']);
  });

  it('scores a user verdict that lands after', async () => {
    const target = run({ outcome: 'revised' });
    const { deps, store } = setup({ judge: prefersOld }, [target]);
    await go(proposal({ citedRunIds: [target.id] }), deps);
    expect(store.noteUserVerdict('es', 100, 'approved')).toMatchObject({ outcome: 'fail', agreed: false });
  });
});

describe('resuming', () => {
  it('re-runs an interrupted eval under the same id from a clean slate', async () => {
    const target = run({ outcome: 'edited' });
    const { deps, store } = setup({}, [target]);
    const stale = store.save({ ...newEvalRecord({ action: 'code.reply-pr-comments', editSessionId: 'es', proposal: proposal({ citedRunIds: [target.id] }) }, 'old', 1), spentUsd: 3, replays: [{ runId: 'x', kind: 'target', valid: false, misses: 0, costUsd: 3 }] });
    const rec = await runEval(stale, deps);
    expect(rec.id).toBe('old');
    expect(rec.replays.map((r) => r.runId)).toEqual([target.id]);
    expect(store.pending()).toEqual([]);
  });
});

describe('budget', () => {
  it('reserves judge cost out of each replay budget and stops below a floor', async () => {
    const targets = [run({ outcome: 'edited' }), run({ outcome: 'edited' })];
    const budgets: number[] = [];
    const { deps } = setup({
      capUsd: 2,
      replay: async (_r, _c, _id, budget) => { budgets.push(budget); return { valid: true, misses: 0, costUsd: 0.9, output: [] }; },
      judge: async () => ({ winner: 'tie', reason: '', costUsd: 0.4 }),
    }, targets);
    await go(proposal({ citedRunIds: targets.map((t) => t.id) }), deps);
    expect(budgets[0]).toBeLessThan(2);
    expect(budgets).toHaveLength(1);
  });
});

describe('EvalQueue', () => {
  it('runs nothing until started', async () => {
    const q = new EvalQueue();
    let ran = false;
    q.enqueue(async () => { ran = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(ran).toBe(false);
    q.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(ran).toBe(true);
  });

  it('runs one job at a time and survives a failure', async () => {
    const q = new EvalQueue();
    q.start();
    const order: string[] = [];
    let release!: () => void;
    q.enqueue(async () => { order.push('a:start'); await new Promise<void>((r) => { release = r; }); order.push('a:end'); });
    q.enqueue(async () => { throw new Error('boom'); });
    const done = new Promise<void>((resolve) => q.enqueue(async () => { order.push('c'); resolve(); }));
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(['a:start']);
    release();
    await done;
    expect(order).toEqual(['a:start', 'a:end', 'c']);
  });
});
