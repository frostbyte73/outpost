import { describe, it, expect } from 'vitest';
import { answerKeyFor, buildReplaySet, isReplayable } from '../../src/eval/replay-set.js';
import type { ActionRunRecord } from '../../src/storage/action-runs-store.js';

let n = 0;
const run = (over: Partial<ActionRunRecord> = {}): ActionRunRecord => ({
  id: `r${++n}`, action: 'code.reply-pr-comments', round: 'draft', attempt: 1, jobId: 'j', stepId: 's',
  startedAt: n, envelopeRef: 'env', outputRef: 'out', skillSha: 'sha', outcome: 'accepted', verdictAt: n,
  ...over,
});

const GIT = { baseSha: 'b', gitDir: '/repo/.git', worktreePath: '/wt' };

describe('isReplayable', () => {
  it('needs a git snapshot for a round that ran in a worktree, and for any code round', () => {
    expect(isReplayable(run())).toBe(true);
    expect(isReplayable(run(GIT))).toBe(true);
    expect(isReplayable(run({ worktreePath: '/wt', baseSha: '', gitDir: '' }))).toBe(false);
    expect(isReplayable(run({ action: 'code.implement' }))).toBe(false);
  });
});

describe('buildReplaySet', () => {
  it('keeps cited targets that are adjudicated, replayable, unspent and not superseded', () => {
    const ok = run({ outcome: 'edited' });
    const superseded = run({ outcome: 'superseded' });
    const spent = run({ outcome: 'revised' });
    const noOutput = run({ outcome: 'denied', outputRef: undefined });
    const noGit = run({ outcome: 'denied', baseSha: 'abc' });
    const pending = run({ outcome: 'submitted', verdictAt: undefined });
    const set = buildReplaySet({
      citedRunIds: [ok.id, superseded.id, spent.id, noOutput.id, noGit.id, pending.id, 'ghost'],
      cutOnly: false,
      runs: [ok, superseded, spent, noOutput, noGit, pending],
      spent: new Set([spent.id]),
    });
    expect(set.targets.map((r) => r.id)).toEqual([ok.id]);
  });

  it('accepts a failed run and a linked code round as targets', () => {
    const failed = run({ outcome: 'failed', verdictAt: undefined, failureReason: 'boom' });
    const code = run({ ...GIT, action: 'code.implement', round: 'code.implement', outcome: 'accepted', verdictAt: undefined, links: [{ kind: 'ciFailed', at: 1 }] });
    const set = buildReplaySet({ citedRunIds: [failed.id, code.id], cutOnly: false, runs: [failed, code], spent: new Set() });
    expect(set.targets).toHaveLength(2);
  });

  it('caps targets at four in cited order', () => {
    const rs = Array.from({ length: 5 }, () => run({ outcome: 'edited' }));
    const set = buildReplaySet({ citedRunIds: rs.map((r) => r.id).reverse(), cutOnly: false, runs: rs, spent: new Set() });
    expect(set.targets.map((r) => r.id)).toEqual(rs.map((r) => r.id).reverse().slice(0, 4));
  });

  it('picks up to three newest accepted regression runs, distinct rounds first', () => {
    const a1 = run({ round: 'draft' });
    const a2 = run({ round: 'draft' });
    const b = run({ round: 'redraft' });
    const gateless = run({ round: 'commit', verdictAt: undefined });
    const target = run({ outcome: 'edited' });
    const set = buildReplaySet({ citedRunIds: [target.id], cutOnly: false, runs: [a1, a2, b, gateless, target], spent: new Set() });
    expect(set.regression.map((r) => r.id)).toEqual([b.id, a2.id, a1.id]);
    expect(set.regressionAvailable).toBe(3);
  });

  it('counts a merged code round as regression-eligible', () => {
    const merged = run({ ...GIT, action: 'code.implement', verdictAt: undefined, links: [{ kind: 'merged', at: 1, prUrl: 'u' }] });
    const set = buildReplaySet({ citedRunIds: [], cutOnly: true, runs: [merged], spent: new Set() });
    expect(set.regression).toHaveLength(1);
  });
});

describe('answerKeyFor', () => {
  const blobs: Record<string, string> = {
    diff: '-old\n+new',
    out: JSON.stringify([{ tool: 'submit_step_output', args: { output: 'the answer' } }]),
    review: 'missing null check',
  };
  const blob = (ref: string) => blobs[ref];

  it('keys an edit on its diff', () => {
    expect(answerKeyFor(run({ outcome: 'edited', editDiffRef: 'diff' }), blob, 'target')).toContain('+new');
  });

  it('keys a send-back or denial on its note', () => {
    expect(answerKeyFor(run({ outcome: 'revised', feedbackText: 'too long' }), blob, 'target')).toContain('too long');
    expect(answerKeyFor(run({ outcome: 'denied', feedbackText: 'wrong PR' }), blob, 'target')).toContain('wrong PR');
  });

  it('keys a failure on its reason', () => {
    expect(answerKeyFor(run({ outcome: 'failed', failureReason: 'boom' }), blob, 'target')).toContain('boom');
  });

  it('keys a code round on its downstream links', () => {
    const key = answerKeyFor(run({
      action: 'code.implement', outcome: 'accepted',
      links: [{ kind: 'reviewFindings', at: 1, ref: 'review' }, { kind: 'prComments', at: 2, comments: [{ id: 'c', author: 'devin' }] }],
    }), blob, 'target');
    expect(key).toContain('missing null check');
    expect(key).toContain('devin');
  });

  it('keys a regression run on its own approved output', () => {
    expect(answerKeyFor(run(), blob, 'regression')).toContain('the answer');
  });

  it('quotes the original output a target verdict was about', () => {
    expect(answerKeyFor(run({ outcome: 'revised', feedbackText: 'too long' }), blob, 'target')).toContain('the answer');
  });
});
