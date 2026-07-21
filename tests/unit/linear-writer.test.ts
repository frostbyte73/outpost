import { describe, it, expect } from 'vitest';
import { resolveStateId } from '../../src/integrations/linear-writer.js';

// Real workflow states as returned by Linear for the REL team. Two `started`
// states ("In Progress" + "In Review") is the case worth pinning down — a naive
// type-only match would pick the wrong one.
const REL_STATES = [
  { id: 'in-review', type: 'started', name: 'In Review' },
  { id: 'dup', type: 'duplicate', name: 'Duplicate' },
  { id: 'canceled', type: 'canceled', name: 'Canceled' },
  { id: 'todo', type: 'unstarted', name: 'Todo' },
  { id: 'done', type: 'completed', name: 'Done' },
  { id: 'backlog', type: 'backlog', name: 'Backlog' },
  { id: 'in-progress', type: 'started', name: 'In Progress' },
];

describe('resolveStateId', () => {
  it('maps done to the completed state', () => {
    expect(resolveStateId(REL_STATES, 'done')).toBe('done');
  });

  it('maps inProgress to the "In Progress" started state, not "In Review"', () => {
    expect(resolveStateId(REL_STATES, 'inProgress')).toBe('in-progress');
  });

  it('maps inReview to the "In Review" started state', () => {
    expect(resolveStateId(REL_STATES, 'inReview')).toBe('in-review');
  });

  it('falls back to the first completed state when none is named "Done"', () => {
    const states = [{ id: 'shipped', type: 'completed', name: 'Shipped' }];
    expect(resolveStateId(states, 'done')).toBe('shipped');
  });

  it('picks a started state for inProgress even when none is named "In Progress"', () => {
    const states = [{ id: 'doing', type: 'started', name: 'Doing' }];
    expect(resolveStateId(states, 'inProgress')).toBe('doing');
  });

  it('returns null for inReview when the team has no review column', () => {
    const states = [
      { id: 'ip', type: 'started', name: 'In Progress' },
      { id: 'd', type: 'completed', name: 'Done' },
    ];
    expect(resolveStateId(states, 'inReview')).toBeNull();
  });
});
