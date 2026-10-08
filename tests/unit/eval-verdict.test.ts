import { describe, it, expect } from 'vitest';
import { evalVerdict, type Comparison } from '../../src/eval/eval-verdict.js';

const base = {
  action: 'code.reply-pr-comments',
  cutOnly: false,
  targets: ['after', 'after'] as Comparison[],
  regression: ['tie', 'after'] as Comparison[],
  regressionAvailable: 2,
  tokensBefore: 1000,
  tokensAfter: 990,
  ceiling: 6000 as number | null,
  spentUsd: 1,
  capUsd: 5,
};

describe('evalVerdict', () => {
  it('passes when every target is won and nothing regresses', () => {
    expect(evalVerdict(base).outcome).toBe('pass');
  });

  it('tolerates one tie at three targets', () => {
    expect(evalVerdict({ ...base, targets: ['after', 'after', 'tie'] }).outcome).toBe('pass');
  });

  it('tolerates no tie on an artifact action', () => {
    expect(evalVerdict({ ...base, action: 'code.implement', targets: ['after', 'after', 'tie'] }).outcome).toBe('fail');
  });

  it('fails on a lost target', () => {
    expect(evalVerdict({ ...base, targets: ['after', 'before'] }).outcome).toBe('fail');
  });

  it('fails on a regression loss', () => {
    const v = evalVerdict({ ...base, regression: ['before', 'tie'] });
    expect(v.outcome).toBe('fail');
    expect(v.reasons.join(' ')).toMatch(/regression/);
  });

  it('is inconclusive with no valid target', () => {
    expect(evalVerdict({ ...base, targets: [] }).outcome).toBe('inconclusive');
  });

  it('is inconclusive when too few regression runs replayed', () => {
    expect(evalVerdict({ ...base, regression: ['tie'], regressionAvailable: 3 }).outcome).toBe('inconclusive');
  });

  it('fails over the token ceiling', () => {
    expect(evalVerdict({ ...base, tokensBefore: 7000, tokensAfter: 6500 }).outcome).toBe('fail');
  });

  it('skips the ceiling when there is none', () => {
    expect(evalVerdict({ ...base, ceiling: null, tokensBefore: 7000, tokensAfter: 6500 }).outcome).toBe('pass');
  });

  it('allows 5% growth only with three won targets', () => {
    expect(evalVerdict({ ...base, tokensAfter: 1040, targets: ['after', 'after', 'after'] }).outcome).toBe('pass');
    expect(evalVerdict({ ...base, tokensAfter: 1040 }).outcome).toBe('fail');
  });

  it('judges a cut on regression alone and requires it to shrink', () => {
    expect(evalVerdict({ ...base, cutOnly: true, targets: [], tokensAfter: 900 }).outcome).toBe('pass');
    expect(evalVerdict({ ...base, cutOnly: true, targets: [], tokensAfter: 1000 }).outcome).toBe('fail');
  });

  it('will not pass a cut that no regression run checked', () => {
    expect(evalVerdict({ ...base, cutOnly: true, targets: [], regression: [], regressionAvailable: 0, tokensAfter: 900 }).outcome).toBe('inconclusive');
  });

  it('calls an overspend inconclusive, not a failure of the proposal', () => {
    expect(evalVerdict({ ...base, spentUsd: 5.5 }).outcome).toBe('inconclusive');
  });
});
