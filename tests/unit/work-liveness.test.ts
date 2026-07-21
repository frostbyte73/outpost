import { describe, it, expect } from 'vitest';
import { withLiveness } from '../../src/work/job-liveness.js';
import type { JobRecord } from '../../src/work/work-types.js';

function job(partial: Partial<JobRecord>): JobRecord {
  return {
    id: 'j1', source: 'manual', title: 't', description: '', state: 'executing',
    steps: [], createdAt: 0, updatedAt: 0, ...partial,
  } as JobRecord;
}

describe('withLiveness', () => {
  it('marks the orchestrator live when its session is active', () => {
    const j = job({ state: 'planning', orchestratorSessionId: 'orch' });
    const out = withLiveness(j, (id) => id === 'orch');
    expect(out.live.orchestrator).toBe(true);
    expect(out.live.stepIds).toEqual([]);
  });

  it('lists steps whose session is active', () => {
    const j = job({ steps: [
      { id: 's1', type: 'open-pr', state: 'implementing', sessionId: 'a' } as any,
      { id: 's2', type: 'open-pr', state: 'implementing', sessionId: 'b' } as any,
    ] });
    const out = withLiveness(j, (id) => id === 'a');
    expect(out.live.stepIds).toEqual(['s1']);
  });

  it('counts a step live when it has a running fix session', () => {
    const j = job({ steps: [
      { id: 's1', type: 'open-pr', state: 'comment_pending_response', sessionId: 'x',
        editQueue: [{ id: 'e1', commentId: 'c', status: 'running', sessionId: 'fix' }] } as any,
    ] });
    const out = withLiveness(j, (id) => id === 'fix');
    expect(out.live.stepIds).toEqual(['s1']);
  });

  it('ignores cancelled steps and dead sessions', () => {
    const j = job({ steps: [
      { id: 's1', type: 'open-pr', state: 'implementing', sessionId: 'dead', cancelled: true } as any,
      { id: 's2', type: 'action', state: 'resolved', sessionId: 'dead' } as any,
    ] });
    const out = withLiveness(j, () => false);
    expect(out.live).toEqual({ orchestrator: false, stepIds: [] });
  });

  it('does not mutate or persist onto the original job', () => {
    const j = job({ orchestratorSessionId: 'orch' });
    const out = withLiveness(j, () => true);
    expect((j as any).live).toBeUndefined();
    expect(out).not.toBe(j);
  });
});
