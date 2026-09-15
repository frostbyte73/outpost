import { describe, it, expect } from 'vitest';
import { acceptDraft, type DraftHost } from '../../src/work/write-draft-runner.js';
import type { ActionStep, JobRecord, OrchestratedStep, Step } from '../../src/work/work-types.js';
import type { PinnedCall, WriteDraft } from '../../src/work/write-draft.js';

// Skipping every drafted call is the user's most direct statement that an action proposed the
// wrong thing, and the journal lesson it leaves is the ONLY qualitative record of it that
// meta.improve-actions ever reads. It used to say which comment ids were skipped and nothing
// about what was skipped — nine consecutive skips of PR replies that opened "You're correct"
// left a trail from which nobody could tell the replies agreed. These pin the two things that
// makes the record usable: the rejected text is in it, and it is filed against whoever chose
// that text.

const NOW = 1_700_000_000_000;

function harness(step: Step, draft: WriteDraft) {
  const journalled: Array<{ action: string; outcome: string; lesson: string }> = [];
  let cur: Step = { ...step, drafts: [draft] };
  const host: DraftHost = {
    now: () => NOW,
    newId: () => 'n1',
    getJob: (): JobRecord => ({
      id: 'j1', source: 'manual', title: 't', description: '', state: 'executing',
      orchestratorAction: 'meta.orchestrate', steps: [cur], createdAt: 0, updatedAt: 0,
    }),
    getStep: () => cur,
    mutateStep: (_j, _s, fn) => { cur = fn(cur); },
    appendStepEvent: () => {},
    resumeRaiser: () => {},
    settleDispatch: () => {},
    notifyControllerDenied: () => {},
    declineStep: () => {},
    journal: (action, _j, _s, outcome, lesson) => { journalled.push({ action, outcome, lesson }); },
  };
  return { host, journalled };
}

const controllerStep: OrchestratedStep = {
  id: 's1', type: 'orchestrated', title: 'ship it', description: '',
  controller: 'code.orchestrate-pr', workspace: { kind: 'none' }, goal: 'g',
  boundAction: 'code.reply-pr-comments', dispatches: [], inbox: [],
  roundsSpent: 4, consecutiveSelfRounds: 0,
  state: 'gate_pending_approval', sessionId: 'sess1', createdAt: 0, updatedAt: 0,
};

const actionStep: ActionStep = {
  id: 's1', type: 'action', title: 'file it', description: '', goal: 'g',
  action: 'write.linear-issue', workspace: { kind: 'none' },
  state: 'gate_pending_approval', sessionId: 'sess1', createdAt: 0, updatedAt: 0,
};

function replyDraft(calls: PinnedCall[], over: Partial<WriteDraft> = {}): WriteDraft {
  return {
    id: 'd1', action: 'code.reply-pr-comments', raisedBy: { kind: 'controller' },
    summary: 'post 1 reply', calls, requestedAt: 0, ...over,
  };
}

// The body never reaches the command line — the reply text lives in `files` and the command
// only names the /tmp path the daemon writes it to (see code.reply-pr-comments's SKILL.md).
// Quoting the command would record the boilerplate and drop the entire payload.
function reply(id: string, label: string, body: string): PinnedCall {
  return {
    id, label,
    bash: `gh api --method POST "repos/{owner}/{repo}/pulls/7/comments/${id}/replies" --input /tmp/outpost-reply-1.json`,
    files: { '/tmp/outpost-reply-1.json': JSON.stringify({ body }) },
  };
}

const skipAll = (calls: PinnedCall[]) => calls.map((c) => ({ ...c, skip: true }));

describe('the lesson a skipped draft leaves', () => {
  it('quotes the drafted body, not the command that references it', async () => {
    const calls = [reply('1', 'review:ABC', "You're correct — I'll fix that in the next push.")];
    const h = harness(controllerStep, replyDraft(calls));

    expect(await acceptDraft(h.host, 'j1', 's1', 'd1', skipAll(calls))).toEqual({ ok: true });

    const own = h.journalled.find((e) => e.action === 'code.reply-pr-comments')!;
    expect(own.outcome).toBe('skipped');
    expect(own.lesson).toContain("You're correct");
    expect(own.lesson).toContain('review:ABC');
  });

  it('files the same skip against the controller whose brief the payload came from', async () => {
    const calls = [reply('1', 'review:ABC', 'Good catch — done.')];
    const h = harness(controllerStep, replyDraft(calls));

    await acceptDraft(h.host, 'j1', 's1', 'd1', skipAll(calls));

    expect(h.journalled.map((e) => e.action))
      .toEqual(['code.reply-pr-comments', 'code.orchestrate-pr']);
    // The controller chose the text; its copy has to say so, or it reads as a complaint about
    // the round it dispatched rather than about what it put in the note.
    expect(h.journalled[1]!.lesson).toContain('your brief');
    expect(h.journalled[1]!.lesson).toContain('Good catch');
  });

  // A `step` raiser drafted its own payload out of its own judgment. Copying the lesson to the
  // job's orchestrator would blame it for wording it never saw.
  it('leaves one lesson when the drafting action wrote its own payload', async () => {
    const calls: PinnedCall[] = [{ id: 'c1', label: 'linear', tool: { name: 'mcp__linear__save_issue', args: { title: 'x' } } }];
    const draft = replyDraft(calls, { action: 'write.linear-issue', raisedBy: { kind: 'step' } });
    const h = harness(actionStep, draft);

    await acceptDraft(h.host, 'j1', 's1', 'd1', skipAll(calls));

    expect(h.journalled.map((e) => e.action)).toEqual(['write.linear-issue']);
  });

  // JournalStore truncates at 400 chars, which would eat the quoted payloads from the tail
  // backwards — the half that carries the signal. The per-call ration is sized against that cap,
  // so a draft with many long calls is what tests it.
  it('stays inside the journal lesson cap however many calls were skipped', async () => {
    const calls = Array.from({ length: 6 }, (_, i) =>
      reply(`${i}`, `review:PRRC_kwDOG007Ks7csBL${i}`, `You're absolutely right about this one, ${'and I agree completely '.repeat(8)}`));
    const h = harness(controllerStep, replyDraft(calls));

    await acceptDraft(h.host, 'j1', 's1', 'd1', skipAll(calls));

    for (const e of h.journalled) expect(e.lesson.length).toBeLessThanOrEqual(400);
    expect(h.journalled[0]!.lesson).toContain('(+4 more)');
    expect(h.journalled[0]!.lesson).toContain("You're absolutely right");
  });
});
