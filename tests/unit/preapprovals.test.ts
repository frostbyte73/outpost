import { describe, it, expect } from 'vitest';
import {
  GATED_PREAPPROVALS, anyPreapproved, clampToCeiling, effectivePreapprovals,
  loosenedFields, parsePlanReview, parsePreapprovals, sessionGrantRefusal,
} from '../../src/work/preapprovals.js';

describe('effectivePreapprovals', () => {
  it('is fully gated when nothing is set', () => {
    expect(effectivePreapprovals(undefined, undefined)).toEqual(GATED_PREAPPROVALS);
  });

  it('lets a step field override the job default, field by field', () => {
    const e = effectivePreapprovals({ push: true, openPr: true, landing: 'approved' }, { openPr: false, spec: 'auto' });
    expect(e).toEqual({ spec: 'auto', push: true, openPr: false, replies: false, merge: false, landing: 'approved' });
  });

  it('ignores explicitly-undefined step fields instead of re-gating the job value', () => {
    expect(effectivePreapprovals({ push: true }, { push: undefined }).push).toBe(true);
  });
});

describe('clampToCeiling', () => {
  const ceiling = effectivePreapprovals({ spec: 'auto', push: true, landing: 'approved' });

  it('keeps a proposal that is stricter than the ceiling', () => {
    expect(clampToCeiling({ spec: 'gate', push: false }, ceiling)).toEqual({ spec: 'gate', push: false });
  });

  it('pulls every looser field down to the ceiling', () => {
    expect(clampToCeiling({ spec: 'skip', openPr: true, merge: true, landing: 'direct' }, ceiling))
      .toEqual({ spec: 'auto', openPr: false, merge: false, landing: 'approved' });
  });

  it('only returns fields the proposal named, so the rest keep inheriting', () => {
    expect(Object.keys(clampToCeiling({ push: true }, ceiling))).toEqual(['push']);
  });
});

describe('loosenedFields', () => {
  it('names each field the proposal loosens past the ceiling', () => {
    const ceiling = effectivePreapprovals({ push: true });
    expect(loosenedFields({ push: true, openPr: true, spec: 'skip', landing: 'merged' }, ceiling))
      .toEqual(['spec', 'openPr']);
  });
});

describe('anyPreapproved', () => {
  it('is false only for the fully gated value', () => {
    expect(anyPreapproved(GATED_PREAPPROVALS)).toBe(false);
    expect(anyPreapproved(effectivePreapprovals({ landing: 'approved' }))).toBe(true);
    expect(anyPreapproved(effectivePreapprovals({ spec: 'auto' }))).toBe(true);
  });
});

describe('parsePreapprovals', () => {
  it('accepts absence', () => {
    expect(parsePreapprovals(undefined)).toEqual({ ok: true, value: undefined });
  });

  it('accepts a well-formed value', () => {
    expect(parsePreapprovals({ spec: 'skip', push: true, landing: 'approved' }))
      .toEqual({ ok: true, value: { spec: 'skip', push: true, landing: 'approved' } });
  });

  it('refuses unknown keys and bad values', () => {
    expect(parsePreapprovals({ pushh: true }).ok).toBe(false);
    expect(parsePreapprovals({ spec: 'never' }).ok).toBe(false);
    expect(parsePreapprovals({ push: 'yes' }).ok).toBe(false);
    expect(parsePreapprovals([]).ok).toBe(false);
  });
});

describe('sessionGrantRefusal', () => {
  it('refuses a session trying to create a job with pre-approvals or an unreviewed plan', () => {
    expect(sessionGrantRefusal({ title: 't', preapprovals: { push: true } })).toMatch(/only the user/);
    expect(sessionGrantRefusal({ title: 't', planReview: 'auto' })).toMatch(/only the user/);
    expect(sessionGrantRefusal({ title: 't' })).toBeUndefined();
  });
});

describe('parsePlanReview', () => {
  it('accepts gate, auto and absence; refuses anything else', () => {
    expect(parsePlanReview('auto')).toEqual({ ok: true, value: 'auto' });
    expect(parsePlanReview(undefined)).toEqual({ ok: true, value: undefined });
    expect(parsePlanReview('skip').ok).toBe(false);
  });
});
