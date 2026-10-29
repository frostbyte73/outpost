import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { cockpitBoard, stabilizeOrder, sessionsShownInBody } from '../../src/pwa/vm/cockpit-board.js';

const NOW = 1_000_000_000_000;
const NO_LIVE = { orchestrator: false, stepIds: [], sessionIds: [], interactiveSessionIds: [] };
const job = (over: Record<string, unknown> = {}) => ({
  id: 'j1', title: 'Job', source: 'manual', state: 'executing', steps: [], events: [],
  createdAt: NOW - 10_000, updatedAt: NOW - 5_000, live: NO_LIVE, ...over,
});
const orc = (over: Record<string, unknown> = {}) => ({
  id: 's1', type: 'orchestrated', controller: 'code.orchestrate-pr', title: 'Fix', state: 'waiting',
  sessionId: 'sess-s1', dispatches: [], drafts: [], workspace: { kind: 'writable', repoCwd: '/r/outpost' },
  createdAt: NOW, updatedAt: NOW, ...over,
});
const board = (input: Record<string, unknown>) => cockpitBoard({ now: NOW, ...input });

describe('sections', () => {
  it('keeps done and failed jobs until dismissed, drops abandoned', () => {
    const b = board({ jobs: [
      job({ id: 'done', state: 'done' }), job({ id: 'failed', state: 'failed' }),
      job({ id: 'gone', state: 'done', dismissedAt: NOW }), job({ id: 'ab', state: 'abandoned' }),
    ] });
    const ids = [...b.started, ...b.notStarted, ...b.backlog].map((r: any) => r.id).sort();
    expect(ids).toEqual(['done', 'failed']);
  });

  it('a done job reads Done and is dismissable', () => {
    const b = board({ jobs: [job({ id: 'd', state: 'done', steps: [orc({ state: 'resolved' })] })] });
    const r = b.started[0];
    expect(r.status).toEqual({ text: 'Done', tone: 'mute' });
    expect(r.tone).toBe('done');
    expect(r.dismissable).toBe(true);
    expect(r.actions).toEqual([]);
    expect(b.tally.needYou).toBe(0);
  });

  it('finishing counts as activity, so a just-finished job rises', () => {
    const b = board({ jobs: [
      job({ id: 'live', state: 'executing', lastEngagedAt: NOW - 1_000 }),
      job({ id: 'fin', state: 'done', lastEngagedAt: NOW - 9_000, updatedAt: NOW }),
    ] });
    expect(b.started.map((r: any) => r.id)).toEqual(['fin', 'live']);
  });

  it('a live job is not dismissable', () => {
    const b = board({ jobs: [job({ id: 'x', state: 'executing' })] });
    expect(b.started[0].dismissable).toBe(false);
  });

  it('splits started, not started and backlog', () => {
    const b = board({ jobs: [
      job({ id: 'run', state: 'executing' }),
      job({ id: 'review', state: 'plan_pending_review', steps: [orc({ sessionId: undefined })] }),
      job({ id: 'todo', state: 'planning' }),
    ] });
    expect(b.started.map((r: any) => r.id)).toEqual(['run']);
    expect(b.notStarted.map((r: any) => r.id)).toEqual(['review']);
    expect(b.backlog.map((r: any) => r.id)).toEqual(['todo']);
  });

  it('lists only un-archived manual sessions', () => {
    const b = board({ projects: [{ cwd: '/r/livekit', sessions: [
      { id: 'm', title: 'manual', lastModified: NOW },
      { id: 'a', title: 'archived', lastModified: NOW, archived: true },
      { id: 'x', title: 'step', lastModified: NOW, sessionClass: 'action' },
    ] }] });
    expect(b.sessions.map((r: any) => r.id)).toEqual(['m']);
    expect(b.sessions[0].ref).toBe('r/livekit');
  });

  it('puts proposals and failed routines in other, never jobs or approvals', () => {
    const b = board({
      jobs: [job({ state: 'plan_pending_review' })],
      pendingApprovals: [{ approvalId: 'p', sessionId: 'zz', toolName: 'Bash' }],
      runs: [{ id: 'r1', kind: 'sched', refs: { scheduleId: 'nightly' }, title: 'nightly-e2e', verdict: 'failed', startedAt: NOW - 100, durationMs: 10 }],
    });
    expect(b.other.map((r: any) => r.inboxItem.kind)).toEqual(['routine-failed']);
  });

  it('is empty only when every section is', () => {
    expect(board({}).empty).toBe(true);
    expect(board({ jobs: [job()] }).empty).toBe(false);
  });
});

describe('job rows', () => {
  it('a spec gate reads "Spec ready" in your-move tone', () => {
    const r = board({ jobs: [job({ steps: [orc({ state: 'gate_pending_approval', phase: 'spec', gate: { question: 'Approve?', draft: '# spec' } })] })] }).started[0];
    expect(r.tone).toBe('you');
    expect(r.status).toEqual({ text: 'Spec ready', tone: 'you' });
    expect(r.actions.map((a: any) => a.kind)).toEqual(['gate']);
    expect(r.actionLabel).toBe('Review spec');
  });

  it('streaming plus a dispatch draft stays live but says your move', () => {
    const step = orc({
      state: 'running',
      dispatches: [{ id: 'd1', action: 'code.implement', status: 'awaiting_approval', sessionId: 'sess-d1' }],
      drafts: [{ id: 'dr1', raisedBy: { kind: 'dispatch', dispatchId: 'd1' } }],
    });
    const r = board({ jobs: [job({ steps: [step], live: { ...NO_LIVE, stepIds: ['s1'], sessionIds: ['sess-s1'] } })] }).started[0];
    expect(r.tone).toBe('live');
    expect(r.status).toEqual({ text: '1 write to approve', tone: 'you' });
    expect(r.feeds).toEqual([{ sessionId: 'sess-s1', stepId: 's1', repo: 'r/outpost', action: 'code.orchestrate-pr' }]);
  });

  it('feeds one block per live session including dispatches', () => {
    const step = orc({ state: 'waiting', dispatches: [{ id: 'd1', action: 'code.implement', status: 'running', sessionId: 'sess-d1' }] });
    const r = board({ jobs: [job({ steps: [step], live: { ...NO_LIVE, stepIds: ['s1'], sessionIds: ['sess-d1'] } })] }).started[0];
    expect(r.feeds.map((f: any) => [f.sessionId, f.action])).toEqual([['sess-d1', 'code.implement']]);
  });

  it('counts several waiting things as "N need you"', () => {
    const steps = [
      orc({ id: 'a', state: 'gate_pending_approval', gate: { question: 'Merge?' } }),
      { id: 'b', type: 'action', action: 'meta.wait', title: 'Soak', state: 'waiting', inputs: { reason: 'canary' }, createdAt: NOW, updatedAt: NOW },
    ];
    const r = board({ jobs: [job({ steps })] }).started[0];
    expect(r.status.text).toBe('2 need you');
    expect(r.actionLabel).toBe('Review');
  });

  it('a failed job offers retry', () => {
    const r = board({ jobs: [job({ state: 'failed', failure: { reason: 'boom', at: NOW } })] }).started[0];
    expect(r.tone).toBe('failed');
    expect(r.status).toEqual({ text: 'Failed: boom', tone: 'failed' });
  });
});

describe('session rows', () => {
  const proj = (s: Record<string, unknown>) => [{ cwd: '/r/livekit', sessions: [{ id: 'm', title: 't', lastModified: NOW - 60_000, ...s }] }];

  it('working when its turn is in flight', () => {
    const r = board({ projects: proj({ runState: 'background' }), slices: new Map([['m', { thinking: true, runState: 'background' }]]) }).sessions[0];
    expect(r.tone).toBe('live');
    expect(r.feeds).toHaveLength(1);
  });

  it('a live, read, not-working session is idle with no feed', () => {
    const r = board({ projects: proj({ runState: 'background' }) }).sessions[0];
    expect(r.tone).toBe('idle');
    expect(r.status.text).toBe('Idle');
    expect(r.actions).toEqual([]);
    expect(r.feeds).toEqual([]);
  });

  it('opening a session does not change its row', () => {
    const closed = board({ projects: proj({}) }).sessions[0];
    const opened = board({ projects: proj({ runState: 'foreground' }), slices: new Map([['m', { runState: 'foreground', thinking: false }]]) }).sessions[0];
    expect(opened).toEqual(closed);
  });

  it('an unread session reads Unread in your-move tone with no action', () => {
    const activity = new Map([['m', { working: false, lastReplyAt: NOW - 1000, seenAt: NOW - 5000 }]]);
    const r = board({ projects: proj({}), activity }).sessions[0];
    expect(r.tone).toBe('you');
    expect(r.status).toEqual({ text: 'Unread', tone: 'you' });
    expect(r.actions).toEqual([]);
  });

  it('a pending approval outranks unread', () => {
    const activity = new Map([['m', { working: false, lastReplyAt: NOW - 1000, seenAt: NOW - 5000 }]]);
    const r = board({ projects: proj({}), activity, pendingApprovals: [{ approvalId: 'p', sessionId: 'm', toolName: 'Bash' }] }).sessions[0];
    expect(r.status.text).toBe('Approve Bash');
  });

  it('working from the daemon activity feed reads as live with a feed', () => {
    const r = board({ projects: proj({}), activity: new Map([['m', { working: true, lastReplyAt: null, seenAt: 0 }]]) }).sessions[0];
    expect(r.tone).toBe('live');
    expect(r.feeds).toHaveLength(1);
  });

  it('feeds a session holding a pending approval', () => {
    const r = board({ projects: proj({ runState: 'background' }), pendingApprovals: [{ approvalId: 'p', sessionId: 'm', toolName: 'Bash' }] }).sessions[0];
    expect(r.feeds).toHaveLength(1);
  });

  it('idle with no feed once the process has exited', () => {
    const r = board({ projects: proj({}) }).sessions[0];
    expect(r.tone).toBe('idle');
    expect(r.feeds).toEqual([]);
  });

  it('holds a row for a session launched here before the daemon lists it', () => {
    const slices = new Map([['new', { cwd: '/r/outpost', title: 'Fix it' }]]);
    const b = board({ projects: proj({}), slices, launched: new Set(['new', 'm']) });
    expect(b.sessions.map((r: any) => r.id)).toEqual(['new', 'm']);
    expect(b.sessions[0]).toMatchObject({ key: 'session:new', title: 'Fix it', ref: 'r/outpost' });
  });
});

describe('ordering', () => {
  it('orders by last engagement, falling back to createdAt for legacy jobs', () => {
    const b = board({ jobs: [
      job({ id: 'old-touched', createdAt: NOW - 9e9, lastEngagedAt: NOW - 1 }),
      job({ id: 'legacy', createdAt: NOW - 100 }),
      job({ id: 'stale', createdAt: NOW - 9e9, lastEngagedAt: NOW - 9e8 }),
    ] });
    expect(b.started.map((r: any) => r.id)).toEqual(['old-touched', 'legacy', 'stale']);
  });

  it('sessions use the newest of server and local engagement, else lastModified', () => {
    const b = board({
      projects: [{ cwd: '/r/p', sessions: [
        { id: 'a', title: 'a', lastModified: NOW - 10, lastEngagedAt: NOW - 1000 },
        { id: 'b', title: 'b', lastModified: NOW - 500 },
        { id: 'c', title: 'c', lastModified: NOW - 9000, lastEngagedAt: NOW - 9000 },
      ] }],
      localEngaged: new Map([['c', NOW]]),
    });
    expect(b.sessions.map((r: any) => r.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('stabilizeOrder', () => {
  it('passes the desired order through when nothing is pinned', () => {
    expect(stabilizeOrder(['a', 'b'], ['b', 'a'], new Set())).toEqual(['b', 'a']);
  });
  it('holds only the pinned row in its prior slot; the rest re-sort around it', () => {
    expect(stabilizeOrder(['a', 'b', 'c'], ['c', 'a', 'b'], new Set(['b']))).toEqual(['c', 'b', 'a']);
  });
  it('places a newcomer where the order wants it, pinned rows still held', () => {
    expect(stabilizeOrder(['a', 'b'], ['n', 'b', 'a'], new Set(['a']))).toEqual(['a', 'n', 'b']);
  });
  it('drops a pinned row that left', () => {
    expect(stabilizeOrder(['a', 'b'], ['b'], new Set(['a']))).toEqual(['b']);
  });
  it('moves a pinned row up when a row above it leaves, rather than backfilling', () => {
    expect(stabilizeOrder(['a', 'b', 'c'], ['b', 'c'], new Set(['b']))).toEqual(['b', 'c']);
    expect(stabilizeOrder(['a', 'b', 'c'], ['c', 'b'], new Set(['b']))).toEqual(['b', 'c']);
  });
  it('has nothing to hold on first paint', () => {
    expect(stabilizeOrder(null, ['b', 'a'], new Set(['a']))).toEqual(['b', 'a']);
  });
});

describe('sessionsShownInBody', () => {
  it('a session row body shows its own session', () => {
    expect(sessionsShownInBody({ kind: 'session', id: 'm', actions: [] }, 'caret')).toEqual(['m']);
  });
  it('a job action body shows driven sessions', () => {
    const row = { kind: 'job', id: 'j', actions: [{ kind: 'driven', sessionId: 'x' }, { kind: 'gate' }], feeds: [] };
    expect(sessionsShownInBody(row, 'action')).toEqual(['x']);
    expect(sessionsShownInBody(row, null)).toEqual([]);
  });
  it('a job caret body takes over its steps’ feeds but leaves the planner’s on the row', () => {
    const row = { kind: 'job', id: 'j', actions: [], feeds: [{ sessionId: 'o', stepId: null }, { sessionId: 's', stepId: 'st' }] };
    expect(sessionsShownInBody(row, 'caret')).toEqual(['s']);
  });
});
