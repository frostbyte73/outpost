import { describe, it, expect } from 'vitest';
import { acceptDraft, denyDraft, reviseDraft, submitDraft, type DraftHost } from '../../src/work/write-draft-runner.js';
import type { ActionStep, JobRecord, Step } from '../../src/work/work-types.js';
import type { DraftVerdictDetail } from '../../src/work/draft-verdict.js';

// "Approved as drafted" vs "rewritten, then approved", and wrong vs overtaken by events.

const NOW = 1_700_000_000_000;
const base: ActionStep = {
  id: 's1', type: 'action', title: 't', description: '', goal: 'g', action: 'write.linear-comment',
  workspace: { kind: 'none' }, state: 'running', sessionId: 'sess1', createdAt: 0, updatedAt: 0,
};

function harness(step: Step = base) {
  let cur: Step = step;
  const notes: Array<{ detail: DraftVerdictDetail; stateAtNote: Step['state'] }> = [];
  const host: DraftHost = {
    now: () => NOW, newId: () => 'd1',
    getJob: (): JobRecord => ({ id: 'j1', source: 'manual', title: 't', description: '', state: 'executing', steps: [cur], createdAt: 0, updatedAt: 0 }),
    getStep: () => cur,
    mutateStep: (_j, _s, fn) => { cur = fn(cur); },
    appendStepEvent: () => {}, resumeRaiser: () => {}, settleDispatch: () => {},
    notifyControllerDenied: () => {}, declineStep: () => {}, journal: () => {},
    noteVerdict: (_j, _s, detail) => { notes.push({ detail, stateAtNote: cur.state }); },
  };
  return { host, notes, cur: () => cur };
}

const call = { id: 'c1', label: 'comment', tool: { name: 'mcp__claude_ai_Linear__save_comment', args: { body: 'Long verbose text' } } };
const draftIn = { action: 'write.linear-comment', raisedBy: { kind: 'step' as const }, summary: 's', calls: [call] };

describe('draft verdict detail', () => {
  it('keeps the drafted calls and reports an edit before the accept mutates the step', async () => {
    const h = harness();
    await submitDraft(h.host, 'j1', 's1', draftIn);
    expect(h.cur().drafts![0]!.draftedCalls).toEqual([call]);
    await acceptDraft(h.host, 'j1', 's1', 'd1', [{ ...call, tool: { ...call.tool, args: { body: 'Short' } } }]);
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]!.detail.edit?.diff).toContain('Short');
    expect(h.notes[0]!.stateAtNote).toBe('gate_pending_approval');
  });

  it('drops the drafted copy once the draft is approved', async () => {
    const h = harness();
    await submitDraft(h.host, 'j1', 's1', draftIn);
    await acceptDraft(h.host, 'j1', 's1', 'd1', [call]);
    expect(h.cur().drafts![0]).not.toHaveProperty('draftedCalls');
    expect(h.cur().drafts![0]).not.toHaveProperty('factsAtDraft');
  });

  it('reports no edit on a verbatim accept', async () => {
    const h = harness();
    await submitDraft(h.host, 'j1', 's1', draftIn);
    await acceptDraft(h.host, 'j1', 's1', 'd1', [call]);
    expect(h.notes[0]!.detail.edit).toBeUndefined();
  });

  it('reports skip-all as an edit', async () => {
    const h = harness();
    await submitDraft(h.host, 'j1', 's1', draftIn);
    await acceptDraft(h.host, 'j1', 's1', 'd1', [{ ...call, skip: true }]);
    expect(h.notes[0]!.detail.edit).toBeDefined();
  });

  it('carries feedback text on revise', async () => {
    const h = harness();
    await submitDraft(h.host, 'j1', 's1', draftIn);
    reviseDraft(h.host, 'j1', 's1', 'd1', 'shorter please');
    expect(h.notes[0]!.detail).toMatchObject({ feedbackText: 'shorter please', stale: false });
  });

  it('marks a deny stale when PR facts moved since the draft', async () => {
    const orch = {
      id: 's1', type: 'orchestrated', title: 't', description: '', controller: 'code.orchestrate-pr',
      workspace: { kind: 'none' }, goal: 'g', dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
      state: 'running', sessionId: 'sess1', createdAt: 0, updatedAt: 0, pr: { headRefOid: 'a' },
    } as unknown as Step;
    const h = harness(orch);
    await submitDraft(h.host, 'j1', 's1', { ...draftIn, action: 'code.reply-pr-comments', raisedBy: { kind: 'controller' } });
    h.host.mutateStep('j1', 's1', (s) => ({ ...s, pr: { headRefOid: 'b' } }) as Step);
    denyDraft(h.host, 'j1', 's1', 'd1', 'there is a conflict now');
    expect(h.notes[0]!.detail).toMatchObject({ feedbackText: 'there is a conflict now', stale: true });
  });
});
