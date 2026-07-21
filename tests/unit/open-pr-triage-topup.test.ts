import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPrHandler } from '../../src/steps/open-pr.js';
import type { JobRecord, OpenPrStep, DraftedReply, PrComment } from '../../src/work/work-types.js';
import type { HandlerCtx } from '../../src/steps/types.js';

function ctx(): HandlerCtx {
  return { jobsDir: mkdtempSync(join(tmpdir(), 'orch-triage-')), newId: () => 'id', now: () => 1 };
}

function comment(id: string, extra: Partial<PrComment> = {}): PrComment {
  return { id, author: 'devin', body: '...', createdAt: 1, ...extra };
}

function draft(commentId: string, extra: Partial<DraftedReply> = {}): DraftedReply {
  return { commentId, recommendation: 'reply', rationale: 'r', draftReply: 'd', ...extra };
}

function step(state: OpenPrStep['state'], overrides: Partial<OpenPrStep> = {}): OpenPrStep {
  return {
    id: 's1',
    title: 't',
    description: 'd',
    type: 'open-pr',
    workspace: { kind: 'writable', repoCwd: '/tmp', branch: 'feat/x' },
    goal: 'g',
    approach: 'a',
    state,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function job(s: OpenPrStep): JobRecord {
  return {
    id: 'j1', source: 'manual', title: 't', description: 'd',
    state: 'executing', steps: [s], createdAt: 0, updatedAt: 0,
  };
}

describe('openPrHandler.decide in reply_pending_review', () => {
  it('spawns a top-up triage when a new comment arrives without a draft', () => {
    const s = step('reply_pending_review', {
      comments: [comment('c1'), comment('c2')],
      draftedReplies: [draft('c1')],
    });
    const a = openPrHandler.decide(s, job(s), ctx());
    expect(a?.kind).toBe('spawn-session');
  });

  it('is idle when every open comment already has a draft', () => {
    const s = step('reply_pending_review', {
      comments: [comment('c1'), comment('c2')],
      draftedReplies: [draft('c1'), draft('c2')],
    });
    expect(openPrHandler.decide(s, job(s), ctx())).toBeNull();
  });

  it('is idle when the only undrafted comment is already responded to', () => {
    const s = step('reply_pending_review', {
      comments: [comment('c1'), comment('c2', { respondedAt: 5 })],
      draftedReplies: [draft('c1')],
    });
    expect(openPrHandler.decide(s, job(s), ctx())).toBeNull();
  });

  it('skips spawn when a replies iteration is already in flight', () => {
    const s = step('reply_pending_review', {
      comments: [comment('c1'), comment('c2')],
      draftedReplies: [draft('c1')],
      iterations: [{ id: 'i1', kind: 'replies', status: 'in_progress', startedAt: 0 }],
    });
    expect(openPrHandler.decide(s, job(s), ctx())).toBeNull();
  });

  it('does not spawn triage while an edit round is running (one session per step)', () => {
    const s = step('reply_pending_review', {
      comments: [comment('c1'), comment('c2')],
      draftedReplies: [draft('c1')],
      editQueue: [{ id: 'e1', commentId: 'cX', status: 'running' }],
    });
    expect(openPrHandler.decide(s, job(s), ctx())).toBeNull();
  });
});

describe('openPrHandler.buildEnvelope', () => {
  it('excludes drafted comments from the pr-comments round payload', () => {
    const s = step('reply_pending_review', {
      comments: [comment('c1'), comment('c2'), comment('c3', { respondedAt: 5 })],
      draftedReplies: [draft('c1')],
    });
    const env = openPrHandler.buildEnvelope(s, job(s), ctx()) as {
      typePayload: { round: { kind: string; comments: PrComment[] } };
    };
    expect(env.typePayload.round.kind).toBe('pr-comments');
    expect(env.typePayload.round.comments.map((c) => c.id)).toEqual(['c2']);
  });
});
