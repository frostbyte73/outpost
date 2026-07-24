import { describe, it, expect } from 'vitest';
import { openPrHandler } from '../../src/steps/open-pr.js';
import type { OpenPrEnvelope } from '../../src/work/envelope.js';

describe('open-pr handler shape', () => {
  it('starts in speccing', () => {
    expect(openPrHandler.initialState).toBe('speccing');
  });
  it('is resolved only when merged', () => {
    expect(openPrHandler.isResolved({ state: 'merged' } as any)).toBe(true);
    expect(openPrHandler.isResolved({ state: 'speccing' } as any)).toBe(false);
  });
});

const ctx = { jobsDir: '/tmp/outpost-test-jobs', newId: () => 'x', now: () => 0 } as any;
const baseStep = {
  id: 's1', type: 'open-pr', workspace: { kind: 'writable', repoCwd: '/tmp', branch: 'b' },
  goal: 'g', approach: 'a', title: 't', description: 'd',
} as any;
const job = { id: 'j1', source: 'manual', title: 'T', description: 'D', steps: [] } as any;

it('spec round when speccing, passes feedback', () => {
  const s = { ...baseStep, state: 'speccing', specFeedback: ['tighten scope'] };
  const env = openPrHandler.buildEnvelope(s, job, ctx) as OpenPrEnvelope;
  expect(env.typePayload.round).toEqual({ kind: 'spec', feedback: ['tighten scope'] });
});
it('plan round when planning, carries spec', () => {
  const s = { ...baseStep, state: 'planning', spec: '# spec' };
  const env = openPrHandler.buildEnvelope(s, job, ctx) as OpenPrEnvelope;
  expect(env.typePayload.round).toEqual({ kind: 'plan' });
  expect(env.spec).toBe('# spec');
});
it('implement round carries spec + plan', () => {
  const s = { ...baseStep, state: 'implementing', spec: '# spec', implPlan: '# plan' };
  const env = openPrHandler.buildEnvelope(s, job, ctx) as OpenPrEnvelope;
  expect(env.typePayload.round).toBe('initial');
  expect(env.implPlan).toBe('# plan');
});
it('spec_pending_review is a gate (no spawn)', () => {
  const s = { ...baseStep, state: 'spec_pending_review', sessionId: 'sess' };
  expect(openPrHandler.decide(s, job, ctx)).toBeNull();
});
