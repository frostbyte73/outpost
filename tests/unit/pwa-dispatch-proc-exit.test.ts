// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { dispatchSession, installDispatchDeps } from '../../src/pwa/ws/dispatch.js';
// @ts-expect-error PWA modules are plain JS.
import { sessions } from '../../src/pwa/state/sessions.js';

const SID = 'sess-1';

function lastEntry() {
  return sessions.getSlice(SID).transcript.at(-1);
}

beforeEach(() => {
  sessions.set({
    view: 'session',
    currentSessionId: SID,
    maxTranscriptLines: 500,
    sessionsById: new Map(),
  });
  sessions.ensureSlice(SID);
  installDispatchDeps({ state: {}, stopThinking() {}, renderSession() {} });
});

describe('daemon_proc_exit', () => {
  it('unexpected exit → crash tile, no reopen (typing wakes it)', () => {
    dispatchSession({ type: 'daemon_proc_exit', code: 143 }, SID);
    const e = lastEntry();
    expect(e.role).toBe('error');
    expect(e.action).toBeUndefined();
    expect(e.text).toContain('143');
  });

  it.each(['idle', 'reauth', 'shutdown'])('daemon-initiated %s exit appends nothing', (reason) => {
    const before = sessions.getSlice(SID).transcript.length;
    dispatchSession({ type: 'daemon_proc_exit', code: 143, expected: true, reason }, SID);
    expect(sessions.getSlice(SID).transcript.length).toBe(before);
  });

  it('daemon-initiated teardown → archived notice', () => {
    dispatchSession({ type: 'daemon_proc_exit', code: 143, expected: true, reason: 'archived' }, SID);
    const e = lastEntry();
    expect(e.role).toBe('archived');
    expect(e.text).toBe('Session archived.');
  });
});
