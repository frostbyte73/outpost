import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain-JS PWA module
import { PRESETS, effective, loosened, presetOf, summaryLabel } from '../../src/pwa/vm/preapprovals.js';

describe('preapprovals vm', () => {
  it('recognises each preset and anything else as custom', () => {
    expect(presetOf(undefined)).toBe('gated');
    expect(presetOf(PRESETS.routine)).toBe('routine');
    expect(presetOf(PRESETS.personal)).toBe('personal');
    expect(presetOf({ ...PRESETS.routine, merge: true })).toBe('custom');
  });

  it('matches the daemon presets from the spec', () => {
    expect(PRESETS.routine).toEqual({ spec: 'skip', push: true, openPr: true, replies: true, merge: false, syncBase: false, landing: 'approved' });
    expect(PRESETS.personal).toEqual({ spec: 'auto', push: true, openPr: false, replies: false, merge: false, syncBase: false, landing: 'direct' });
  });

  it('marks what a proposal loosens past the job settings', () => {
    expect(loosened({ push: true, merge: true, spec: 'skip' }, { push: true })).toEqual(['spec', 'merge']);
    expect(loosened(undefined, { push: true })).toEqual([]);
  });

  it('summarises a custom value by what it turns on', () => {
    expect(summaryLabel(PRESETS.routine)).toBe('Routine');
    expect(summaryLabel(undefined)).toBe('Gated');
    expect(summaryLabel({ push: true, landing: 'approved' })).toBe('push · approved');
    expect(effective({ push: true }, { push: false }).push).toBe(false);
  });
});
