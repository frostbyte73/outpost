import { describe, it, expect } from 'vitest';
import { deriveLinkEvents } from '../../src/work/action-run-links.js';
import type { JobRecord, OrchestratedStep } from '../../src/work/work-types.js';

const orch = (over: Partial<OrchestratedStep>): OrchestratedStep => ({
  id: 's1', type: 'orchestrated', title: 't', description: '', controller: 'code.orchestrate-pr',
  workspace: { kind: 'none' }, goal: 'g', dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
  state: 'running', createdAt: 0, updatedAt: 0, ...over,
} as OrchestratedStep);
const job = (s: OrchestratedStep): JobRecord => ({ id: 'j', source: 'manual', title: 't', description: '', state: 'executing', steps: [s], createdAt: 0, updatedAt: 0 });

describe('deriveLinkEvents', () => {
  it('links CI failure, new comments, review artifact changes and merge', () => {
    const prev = job(orch({ pr: { ciState: 'pending', comments: [{ id: 'c1', author: 'a', body: 'x', createdAt: 0 }] }, artifacts: { review: 'pass 1 — clean' } }));
    const next = job(orch({
      pr: { ciState: 'failure', headRefOid: 'h', prState: 'merged', prUrl: 'u',
        comments: [{ id: 'c1', author: 'a', body: 'x', createdAt: 0 }, { id: 'c2', author: 'devin', body: 'y', createdAt: 0 }] },
      artifacts: { review: 'pass 2 — blocking' },
    }));
    expect(deriveLinkEvents(prev, next, 9)).toEqual(expect.arrayContaining([
      { stepId: 's1', link: { kind: 'ciFailed', at: 9, headSha: 'h' } },
      { stepId: 's1', link: { kind: 'prComments', at: 9, comments: [{ id: 'c2', author: 'devin' }] } },
      { stepId: 's1', link: { kind: 'reviewFindings', at: 9, ref: 'pass 2 — blocking' } },
      { stepId: 's1', link: { kind: 'merged', at: 9, prUrl: 'u' }, all: true },
    ]));
  });

  it('emits nothing on a first observation or an unchanged step', () => {
    const s = job(orch({ pr: { ciState: 'failure' } }));
    expect(deriveLinkEvents(undefined, s, 1)).toEqual([]);
    expect(deriveLinkEvents(s, s, 1)).toEqual([]);
  });
});
