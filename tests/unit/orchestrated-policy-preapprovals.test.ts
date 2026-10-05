import { describe, it, expect } from 'vitest';
import { validateNext } from '../../src/steps/orchestrated-policy.js';
import { effectivePreapprovals } from '../../src/work/preapprovals.js';
import { resolveGate, applyMove, type OrchestratedHost } from '../../src/work/orchestrated-runner.js';
import type { OrchestratedStep } from '../../src/work/work-types.js';

// Row 2's spec gate used to be prose a controller could walk past. Under spec: 'gate' the
// daemon now refuses planning or implementing until the user approved the spec.

const info = { sideEffects: () => 'none' as const };
const base: OrchestratedStep = {
  id: 's1', type: 'orchestrated', title: 't', description: '', controller: 'code.orchestrate-pr', goal: 'g',
  workspace: { kind: 'writable', repoCwd: '/r', branch: 'b' }, dispatches: [], inbox: [],
  roundsSpent: 2, consecutiveSelfRounds: 0, state: 'running', createdAt: 0, updatedAt: 0,
};
const gated = effectivePreapprovals();
const bind = (action: string) => ({ kind: 'self-round' as const, action });

describe('the spec gate', () => {
  it('refuses planning or implementing an unapproved spec', () => {
    const s = { ...base, artifacts: { spec: 'S' } };
    expect(validateNext(s, bind('code.plan'), info, false, gated)).toMatchObject({ kind: 'reject' });
    expect(validateNext(s, bind('code.implement'), info, false, gated)).toMatchObject({ kind: 'reject' });
  });

  it('refuses implementing before any spec exists', () => {
    expect(validateNext(base, bind('code.implement'), info, false, gated)).toMatchObject({ kind: 'reject' });
  });

  it('allows it once the spec gate was approved', () => {
    const s = { ...base, artifacts: { spec: 'S' }, specApprovedAt: 5 };
    expect(validateNext(s, bind('code.plan'), info, false, gated)).toMatchObject({ kind: 'allow' });
  });

  // gateApproved outlives the spec it approved and answers every gate, not just this one.
  it('does not take a bare gateApproved as approval of the spec', () => {
    const s = { ...base, artifacts: { spec: 'S' }, gateApproved: true };
    expect(validateNext(s, bind('code.plan'), info, false, gated)).toMatchObject({ kind: 'reject' });
  });

  it('is not exempted by an implPlan the controller wrote itself', () => {
    const s = { ...base, artifacts: { spec: 'S', implPlan: 'P' } };
    expect(validateNext(s, bind('code.implement'), info, false, gated)).toMatchObject({ kind: 'reject' });
  });

  it('does not apply under spec auto or skip', () => {
    expect(validateNext(base, bind('code.implement'), info, false, effectivePreapprovals({ spec: 'skip' }))).toMatchObject({ kind: 'allow' });
    expect(validateNext({ ...base, artifacts: { spec: 'S' } }, bind('code.plan'), info, false, effectivePreapprovals({ spec: 'auto' }))).toMatchObject({ kind: 'allow' });
  });

  it('leaves the spec round itself and every other rebind alone', () => {
    expect(validateNext(base, bind('code.spec'), info, false, gated)).toMatchObject({ kind: 'allow' });
    expect(validateNext(base, bind('code.fix-ci'), info, false, gated)).toMatchObject({ kind: 'allow' });
  });

  it('also refuses dispatching a planning round', () => {
    const move = { kind: 'dispatch' as const, dispatches: [{ action: 'code.plan', brief: 'b', workspace: { kind: 'none' as const } }] };
    expect(validateNext({ ...base, artifacts: { spec: 'S' } }, move, info, false, gated)).toMatchObject({ kind: 'reject' });
  });
});

describe('resolve with the PR open', () => {
  const open = { ...base, pr: { prUrl: 'https://github.com/o/r/pull/1', prState: 'open' as const, reviewState: 'approved' as const, ciState: 'success' as const } };
  const resolve = { kind: 'resolve' as const, output: 'o' };

  it('is allowed for an approved landing once approved and green', () => {
    expect(validateNext(open, resolve, info, false, effectivePreapprovals({ landing: 'approved' }))).toMatchObject({ kind: 'allow' });
  });
  it('is still refused for an approved landing while CI pends', () => {
    expect(validateNext({ ...open, pr: { ...open.pr, ciState: 'pending' } }, resolve, info, false, effectivePreapprovals({ landing: 'approved' })))
      .toMatchObject({ kind: 'reject' });
  });
  it('is still refused for a merged landing', () => {
    expect(validateNext(open, resolve, info, false, gated)).toMatchObject({ kind: 'reject' });
  });
});

function host(step: OrchestratedStep): { host: OrchestratedHost; get: () => OrchestratedStep } {
  let cur = step;
  return {
    get: () => cur,
    host: {
      getStep: () => cur, mutateStep: (_j, _s, fn) => { cur = fn(cur); }, sessionWorking: () => false,
      resumeController: () => {}, spawnDispatch: () => {}, resolveStep: () => {}, failStep: () => {},
      scheduleDelivery: () => {}, actionInfo: info, newId: () => 'i', now: () => 77,
      preapprovalsFor: () => gated,
    },
  };
}

describe('specApprovedAt', () => {
  it('is stamped when the spec gate is approved', () => {
    const h = host({ ...base, artifacts: { spec: 'S' }, state: 'gate_pending_approval', gate: { draft: 'S', question: 'ok?', requestedAt: 1 } });
    resolveGate(h.host, 'j', 's1', true);
    expect(h.get().specApprovedAt).toBe(77);
  });

  it('is not stamped by a gate approved after planning', () => {
    const h = host({ ...base, artifacts: { spec: 'S', implPlan: 'P' }, state: 'gate_pending_approval', gate: { draft: 'x', question: 'q', requestedAt: 1 } });
    resolveGate(h.host, 'j', 's1', true);
    expect(h.get().specApprovedAt).toBeUndefined();
  });

  it('is cleared when the spec changes', () => {
    const h = host({ ...base, artifacts: { spec: 'S' }, specApprovedAt: 5 });
    applyMove(h.host, 'j', 's1', { artifacts: { spec: 'S2' }, next: { kind: 'gate', draft: 'S2', question: 'ok?' } });
    expect(h.get().specApprovedAt).toBeUndefined();
  });

  it('survives a round that leaves the spec untouched', () => {
    const h = host({ ...base, artifacts: { spec: 'S' }, specApprovedAt: 5 });
    applyMove(h.host, 'j', 's1', { artifacts: { implPlan: 'P' }, next: { kind: 'self-round', action: 'code.implement' } });
    expect(h.get().specApprovedAt).toBe(5);
  });
});
