// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

class FakeWs {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWs[] = [];
  readyState = FakeWs.OPEN;
  onmessage: ((e: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWs.instances.push(this); }
  send(): void {}
  close(): void { this.readyState = FakeWs.CLOSED; this.onclose?.(); }
}

describe('session liveness in the PWA', () => {
  beforeEach(() => {
    FakeWs.instances = [];
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeWs;
    vi.resetModules();
  });

  it('a live session_state brings an exited slice back to foreground', async () => {
    // @ts-expect-error PWA modules are plain JS.
    const { openSessionWs } = await import('../../src/pwa/components/session-view/session-ws.js');
    // @ts-expect-error PWA modules are plain JS.
    const { sessions } = await import('../../src/pwa/state/sessions.js');
    sessions.ensureSlice('s1');
    sessions.setRunState('s1', 'inactive');
    openSessionWs('s1');
    FakeWs.instances[0]!.onmessage?.({ data: JSON.stringify({ type: 'session_state', latestSeq: 0, earliestSeq: 0, working: false, live: true }) });
    expect(sessions.getSlice('s1').runState).toBe('foreground');
  });

  it('the header reads Idle for a viewed session that is not working', async () => {
    // @ts-expect-error PWA modules are plain JS.
    const { sessionRunMeta } = await import('../../src/pwa/components/session-view/session-actions.js');
    expect(sessionRunMeta({ runState: 'foreground', thinking: false }, 's1')).toEqual({ live: false, text: 'Idle' });
    expect(sessionRunMeta({ runState: 'inactive', thinking: true }, 's2').live).toBe(true);
  });
});
