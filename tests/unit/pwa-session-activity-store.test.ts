import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { sessionActivity } from '../../src/pwa/state/session-activity.js';

describe('sessionActivity', () => {
  it('counts only sessions Claude is working in', () => {
    sessionActivity.seed([{ sessions: [{ id: 'a', working: true }, { id: 'b', working: false }, { id: 'c' }] }]);
    expect(sessionActivity.workingCount()).toBe(1);
    sessionActivity.apply({ type: 'session_activity', sessionId: 'b', working: true });
    expect(sessionActivity.workingCount()).toBe(2);
  });

  it('a stale list load never rolls seenAt or lastReplyAt back', () => {
    sessionActivity.apply({ type: 'session_activity', sessionId: 'x', seenAt: 500, lastReplyAt: 400 });
    sessionActivity.seed([{ sessions: [{ id: 'x', seenAt: 100, lastReplyAt: 300 }] }]);
    expect(sessionActivity.get().get('x')).toMatchObject({ seenAt: 500, lastReplyAt: 400 });
  });
});
