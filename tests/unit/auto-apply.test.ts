import { describe, it, expect } from 'vitest';
import { evalSettlement } from '../../src/actions/auto-apply.js';

const base = {
  autoApply: true,
  author: 'improver' as const,
  action: 'code.reply-pr-comments',
  outcome: 'pass' as const,
  installedBody: 'before',
  proposedOver: 'before',
};

describe('evalSettlement', () => {
  it('applies a pass over the body it was evaluated against', () => {
    expect(evalSettlement(base)).toBe('apply');
  });

  it('drops a fail or inconclusive', () => {
    expect(evalSettlement({ ...base, outcome: 'fail' })).toBe('drop');
    expect(evalSettlement({ ...base, outcome: 'inconclusive' })).toBe('drop');
  });

  it('holds a pass whose base changed underneath it', () => {
    expect(evalSettlement({ ...base, installedBody: 'edited by hand' })).toBe('stale');
  });

  it('leaves the card in shadow mode, for a user author, and for a never-auto-applied action', () => {
    expect(evalSettlement({ ...base, autoApply: false })).toBe('card');
    expect(evalSettlement({ ...base, author: 'user',outcome: 'fail' })).toBe('card');
    expect(evalSettlement({ ...base, action: 'code.orchestrate-pr', outcome: 'fail' })).toBe('card');
  });
});
