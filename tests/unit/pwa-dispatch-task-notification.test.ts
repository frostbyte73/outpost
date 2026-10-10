// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { dispatchSession, installDispatchDeps } from '../../src/pwa/ws/dispatch.js';
// @ts-expect-error PWA modules are plain JS.
import { sessions } from '../../src/pwa/state/sessions.js';
// @ts-expect-error PWA modules are plain JS.
import { subagents } from '../../src/pwa/state/subagents.js';

const SID = 'sess-1';
const AGENT = 'a564f9f453b08f0ea';

beforeEach(() => {
  sessions.set({
    view: 'session',
    currentSessionId: SID,
    maxTranscriptLines: 500,
    sessionsById: new Map(),
  });
  sessions.ensureSlice(SID);
  subagents.clearSession(SID);
  subagents.getOrCreateBucket({ sessionId: SID, agentId: AGENT, agentType: 'general-purpose', firstSeenAt: 1 });
  installDispatchDeps({ state: {}, stopThinking() {}, renderSession() {} });
});

describe('system task_notification', () => {
  it('stamps completion on the background agent it names', () => {
    dispatchSession({
      type: 'system',
      subtype: 'task_notification',
      task_id: AGENT,
      tool_use_id: 'toolu_1',
      status: 'completed',
      summary: 'ok',
    }, SID);
    const c = subagents.forSession(SID).byId.get(AGENT).completion;
    expect(c.status).toBe('completed');
    expect(c.summary).toBe('ok');
  });

  it('ignores a task id that is not a known agent', () => {
    dispatchSession({ type: 'system', subtype: 'task_notification', task_id: 'bash-123', status: 'completed' }, SID);
    expect(subagents.forSession(SID).byId.get(AGENT).completion).toBeFalsy();
  });
});
