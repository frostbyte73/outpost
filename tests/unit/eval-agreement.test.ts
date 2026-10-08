import { describe, it, expect } from 'vitest';
import { evalAgreement } from '../../src/eval/eval-agreement.js';
import type { EvalRecord } from '../../src/eval/eval-store.js';

function rec(id: string, patch: Partial<EvalRecord>): EvalRecord {
  return {
    id, action: 'code.reply-pr-comments', editSessionId: `s-${id}`, postedAt: 1,
    proposal: { skillMdBefore: 'a', skillMdAfter: 'b', postedAt: 1 },
    startedAt: Number(id), reasons: [], spentUsd: 1, tokensBefore: 10, tokensAfter: 9, replays: [],
    ...patch,
  };
}

describe('evalAgreement', () => {
  it('splits disagreements into false passes and false fails', () => {
    const a = evalAgreement([
      rec('1', { outcome: 'pass', userVerdict: 'approved', agreed: true }),
      rec('2', { outcome: 'pass', userVerdict: 'rejected', agreed: false }),
      rec('3', { outcome: 'inconclusive', userVerdict: 'approved', agreed: false }),
      rec('4', { outcome: 'fail', userVerdict: 'rejected', agreed: true }),
      rec('5', { outcome: 'fail' }),
      rec('6', {}),
    ]);
    expect(a).toMatchObject({
      total: 6, reviewed: 4, agreed: 2, falsePasses: 1, falseFails: 1, spentUsd: 6,
      byOutcome: { pass: 2, fail: 2, inconclusive: 1 },
    });
    expect(a.recent.map((r) => r.id)).toEqual(['6', '5', '4', '3', '2', '1']);
  });
});
