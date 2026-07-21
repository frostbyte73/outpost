import { describe, it, expect } from 'vitest';
import { reconcile, validateDispositions } from '../../src/work/reconcile.js';
import type { ProposedStep, Step } from '../../src/work/work-types.js';

function actionStep(id: string, title = id, cancelled = false): Step {
  return {
    id,
    type: 'action',
    action: 'read.investigate',
    title,
    description: '',
    goal: '',
    workspace: { kind: 'none' },
    state: 'resolved',
    cancelled: cancelled || undefined,
    createdAt: 0,
    updatedAt: 0,
  } as Step;
}

function proposedAction(title: string, keepId?: string): ProposedStep {
  return {
    type: 'action',
    action: 'read.investigate',
    title,
    description: '',
    goal: '',
    workspace: { kind: 'none' },
    ...(keepId ? { keepId } : {}),
  } as ProposedStep;
}

describe('validateDispositions', () => {
  it('accepts a plan that keeps every non-cancelled step', () => {
    const current = [actionStep('s1'), actionStep('s2')];
    const proposed = [proposedAction('s1 kept', 's1'), proposedAction('s2 kept', 's2')];
    expect(validateDispositions(current, proposed, [])).toEqual({ ok: true });
  });

  it('accepts a plan that drops every non-cancelled step', () => {
    const current = [actionStep('s1'), actionStep('s2')];
    expect(validateDispositions(current, [], ['s1', 's2'])).toEqual({ ok: true });
  });

  it('accepts a mixed keep/drop/add plan', () => {
    const current = [actionStep('s1'), actionStep('s2')];
    const proposed = [proposedAction('s1 kept', 's1'), proposedAction('fresh')];
    expect(validateDispositions(current, proposed, ['s2'])).toEqual({ ok: true });
  });

  it('ignores cancelled steps in the disposition check', () => {
    const current = [actionStep('s1'), actionStep('s2', 's2', true)];
    const proposed = [proposedAction('s1 kept', 's1')];
    expect(validateDispositions(current, proposed, [])).toEqual({ ok: true });
  });

  it('rejects a plan that omits a non-cancelled step', () => {
    const current = [actionStep('s1'), actionStep('s2')];
    const result = validateDispositions(current, [proposedAction('s1 kept', 's1')], []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Missing.*s2/);
  });

  it('rejects overlap between keepId and drops', () => {
    const current = [actionStep('s1')];
    const result = validateDispositions(current, [proposedAction('s1 kept', 's1')], ['s1']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/both kept and dropped/);
  });

  it('rejects an unknown keepId', () => {
    const current = [actionStep('s1')];
    const result = validateDispositions(current, [proposedAction('ghost', 'nope'), proposedAction('s1 kept', 's1')], []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/keepId.*nope.*does not match/);
  });

  it('rejects an unknown drop id', () => {
    const current = [actionStep('s1')];
    const result = validateDispositions(current, [proposedAction('s1 kept', 's1')], ['nope']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/drop id.*nope.*does not match/);
  });

  it('rejects duplicate keepId across proposed steps', () => {
    const current = [actionStep('s1')];
    const result = validateDispositions(current, [proposedAction('a', 's1'), proposedAction('b', 's1')], []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/referenced by more than one/);
  });

  it('rejects duplicate drop ids', () => {
    const current = [actionStep('s1')];
    const result = validateDispositions(current, [], ['s1', 's1']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/listed more than once/);
  });
});

describe('reconcile', () => {
  it('splits proposed into kept + added and passes drops through', () => {
    const current = [actionStep('s1', 'old title'), actionStep('s2')];
    const proposed = [proposedAction('new title', 's1'), proposedAction('brand new')];
    const r = reconcile(current, proposed, ['s2']);
    expect(r.kept).toEqual([{ stepId: 's1', patch: { title: 'new title' } }]);
    expect(r.added).toHaveLength(1);
    expect(r.added[0]!.title).toBe('brand new');
    expect(r.cancelled).toEqual(['s2']);
  });

  it('does not silently keep a step by matchKey when keepId is missing', () => {
    // In the old world a proposed action step with the same action+title would
    // implicitly match an existing step. In the new world that has to be
    // explicit — same shape without keepId is treated as an addition.
    const current = [actionStep('s1', 'same title')];
    const proposed = [proposedAction('same title')];
    const r = reconcile(current, proposed, ['s1']);
    expect(r.kept).toEqual([]);
    expect(r.added).toHaveLength(1);
    expect(r.cancelled).toEqual(['s1']);
  });
});
