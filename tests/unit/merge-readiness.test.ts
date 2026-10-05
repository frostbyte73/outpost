import { describe, it, expect } from 'vitest';
import { mergeBlocker, readMergeReadiness, unansweredCount, type PrSnapshot } from '../../src/work/merge-readiness.js';
import type { PrComment } from '../../src/work/work-types.js';

// The watcher's PR facts can be an hour stale, so a pre-approved merge is judged on a fresh read.

const SHA = 'c'.repeat(40);
const ready: PrSnapshot = {
  reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', headRefOid: SHA,
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
};

describe('mergeBlocker', () => {
  it('is clear when everything holds', () => {
    expect(mergeBlocker(ready, SHA, 0)).toBeUndefined();
  });
  it.each([
    ['review', { ...ready, reviewDecision: 'REVIEW_REQUIRED' }, 0, /review/],
    ['a pending check', { ...ready, statusCheckRollup: [{ name: 't', status: 'IN_PROGRESS' }] }, 0, /check/],
    ['a failed check', { ...ready, statusCheckRollup: [{ name: 't', conclusion: 'FAILURE' }] }, 0, /check/],
    ['no checks at all', { ...ready, statusCheckRollup: [] }, 0, /check/],
    ['conflicts', { ...ready, mergeable: 'CONFLICTING' }, 0, /mergeable/],
    ['a moved head', { ...ready, headRefOid: 'd'.repeat(40) }, 0, /head/],
    ['unanswered comments', ready, 2, /2 unanswered/],
  ])('names %s', (_n, snap, unanswered, re) => {
    expect(mergeBlocker(snap as PrSnapshot, SHA, unanswered as number)).toMatch(re as RegExp);
  });
});

describe('unansweredCount', () => {
  const c = (over: Partial<PrComment>): PrComment => ({ id: 'x', author: 'reviewer', body: 'b', createdAt: 1, ...over });
  it('counts thread roots by other people that have no answer', () => {
    expect(unansweredCount([
      c({ id: '1' }),
      c({ id: '2', respondedAt: 5 }),
      c({ id: '3', author: 'Me' }),
      c({ id: '4', inReplyTo: '1' }),
    ], 'me')).toBe(1);
  });
  it('fails closed when the viewer is unknown', () => {
    expect(unansweredCount([c({ id: '1', author: 'me' })], undefined)).toBe(1);
  });
});

describe('readMergeReadiness', () => {
  it('reads the PR fresh, and judges it', async () => {
    const calls: string[][] = [];
    const runGh = async (_cwd: string, args: string[]) => {
      calls.push(args);
      return args[0] === 'api' ? JSON.stringify({ login: 'me' }) : JSON.stringify(ready);
    };
    expect(await readMergeReadiness(runGh, '/tmp', 42, SHA, [])).toBeUndefined();
    expect(calls.find((a) => a[0] === 'pr')).toEqual(['pr', 'view', '42', '--json', 'reviewDecision,mergeable,headRefOid,statusCheckRollup']);
  });
});
