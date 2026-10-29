import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { sessionGroups } from '../../src/pwa/vm/sessions.js';

function projects() {
  return [
    {
      cwd: '/home/alice/repo-a',
      sessions: [
        { id: 'running', title: 'Fix the bug', lastModified: 3000, archived: false, kind: 'normal' },
        { id: 'idle', title: 'Old session', lastModified: 2000, archived: false, kind: 'normal' },
        { id: 'action', title: 'Orchestrate: login flow', lastModified: 1000, archived: false, kind: 'normal', sessionClass: 'action', actionLabel: 'meta.orchestrate' },
        { id: 'archived', title: 'Ancient session', lastModified: 100, archived: true, kind: 'normal' },
      ],
    },
  ];
}

function sessionsById() {
  return new Map<string, any>([
    ['running', { runState: 'foreground', thinking: true }],
    ['idle', { runState: 'foreground', thinking: false }],
    ['action', { runState: 'background', thinking: true }],
  ]);
}

const ids = (groups: any) =>
  [...groups.sessions, ...groups.actions, ...groups.idle, ...groups.recent].map((s: any) => s.id).sort();

describe('sessionGroups', () => {
  it('splits the running set into sessions vs actions, excludes archived by default', () => {
    const groups = sessionGroups({ projects: projects(), sessionsById: sessionsById() });
    expect(groups.sessions.map((s: any) => s.id)).toEqual(['running']);
    expect(groups.actions.map((s: any) => s.id)).toEqual(['action']);
    expect(groups.idle.map((s: any) => s.id)).toEqual(['idle']);
    expect(groups.recent).toEqual([]);
  });

  it('files a running edit-kind session under actions, and an idle action under idle', () => {
    const rows = projects();
    rows[0]!.sessions.push({ id: 'edit', title: 'Edit action: oncall', lastModified: 500, archived: false, kind: 'action-edit' } as any);
    const live = sessionsById();
    live.set('edit', { runState: 'background', thinking: true });
    live.set('action', { runState: 'background', thinking: false });

    const groups = sessionGroups({ projects: rows, sessionsById: live });
    expect(groups.actions.map((s: any) => s.id)).toEqual(['edit']);
    expect(groups.idle.map((s: any) => s.id)).toEqual(['idle', 'action']);
  });

  it('uses the daemon working flag for a session this tab has no slice for', () => {
    const rows = projects();
    rows[0]!.sessions = rows[0]!.sessions.map((s) => ({ ...s, working: s.id === 'running' })) as any;
    const groups = sessionGroups({ projects: rows, sessionsById: new Map() });
    expect(groups.sessions.map((s: any) => s.id)).toEqual(['running']);
    expect(groups.actions).toEqual([]);
    expect(groups.idle.map((s: any) => s.id).sort()).toEqual(['action', 'idle']);
  });

  it('groups a session that is open with a live process but not working as idle', () => {
    const groups = sessionGroups({ projects: projects(), sessionsById: sessionsById() });
    expect(groups.idle.map((s: any) => s.id)).toContain('idle');
    expect(groups.idle.find((s: any) => s.id === 'idle').state).toBe('idle');
  });

  it('groups an unread manual session with sessions', () => {
    const activity = new Map([['idle', { working: false, lastReplyAt: 5000, seenAt: 4000 }]]);
    const groups = sessionGroups({ projects: projects(), sessionsById: sessionsById(), activity });
    expect(groups.sessions.map((s: any) => s.id).sort()).toEqual(['idle', 'running']);
    expect(groups.sessions.find((s: any) => s.id === 'idle').state).toBe('unread');
  });

  it('never marks an action session unread', () => {
    const live = sessionsById();
    live.set('action', { thinking: false });
    const activity = new Map([['action', { working: false, lastReplyAt: 5000, seenAt: 4000 }]]);
    const groups = sessionGroups({ projects: projects(), sessionsById: live, activity });
    expect(groups.idle.map((s: any) => s.id)).toContain('action');
  });

  it('groups a session holding an approval with sessions', () => {
    const groups = sessionGroups({ projects: projects(), sessionsById: new Map(), approvalSessionIds: new Set(['idle']) });
    expect(groups.sessions.map((s: any) => s.id)).toEqual(['idle']);
    expect(groups.sessions[0].state).toBe('approval');
  });

  it('reveals archived sessions into "recent" when showArchived is set', () => {
    const groups = sessionGroups({ projects: projects(), sessionsById: sessionsById(), showArchived: true });
    expect(groups.recent.map((s: any) => s.id)).toEqual(['archived']);
  });

  it('tab=active keeps only non-idle sessions', () => {
    const groups = sessionGroups({ projects: projects(), sessionsById: sessionsById(), tab: 'active' });
    expect(ids(groups)).toEqual(['action', 'running']);
  });

  it('tab=action keeps only action sessions (sessionClass or edit kinds)', () => {
    const withEdit = projects();
    withEdit[0]!.sessions.push({ id: 'edit', title: 'Edit action: oncall', lastModified: 500, archived: false, kind: 'action-edit' } as any);
    const groups = sessionGroups({ projects: withEdit, sessionsById: sessionsById(), tab: 'action' });
    expect(ids(groups)).toEqual(['action', 'edit']);
  });

  it('tab=session excludes action sessions', () => {
    const groups = sessionGroups({ projects: projects(), sessionsById: sessionsById(), tab: 'session' });
    expect(ids(groups)).toEqual(['idle', 'running']);
  });

  it('filter matches by title substring, case-insensitively', () => {
    const groups = sessionGroups({ projects: projects(), sessionsById: sessionsById(), filter: 'BUG' });
    expect(ids(groups)).toEqual(['running']);
  });

  it('sorts each group by lastModified, newest first', () => {
    const withExtra = projects();
    withExtra[0]!.sessions.push({ id: 'newer-idle', title: 'Newer', lastModified: 2500, archived: false, kind: 'normal' } as any);
    const groups = sessionGroups({ projects: withExtra, sessionsById: sessionsById() });
    expect(groups.idle.map((s: any) => s.id)).toEqual(['newer-idle', 'idle']);
  });
});
