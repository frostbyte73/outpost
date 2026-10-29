import { describe, it, expect, vi } from 'vitest';
import {
  parseWsFrame,
  handleNotificationsMessage,
  handleSessionMessage,
  type NotificationsMessageDeps,
  type SessionMessageDeps,
} from '../../src/ws/client-messages.js';

// `JSON.parse` succeeds (returns a non-object) on all of these — the daemon crash this
// module exists to prevent came from dereferencing `.type` on exactly these values with
// nothing downstream to catch the TypeError.
const NON_OBJECT_FRAMES = ['null', '42', '"str"', 'true', '[]'];

describe('parseWsFrame', () => {
  for (const body of NON_OBJECT_FRAMES) {
    it(`returns null for a "${body}" frame instead of a bare value`, () => {
      expect(parseWsFrame(Buffer.from(body))).toBeNull();
    });
  }

  it('returns null for unparsable JSON', () => {
    expect(parseWsFrame(Buffer.from('{not json'))).toBeNull();
  });

  it('returns the parsed object for a well-formed frame', () => {
    expect(parseWsFrame(Buffer.from('{"type":"interrupt"}'))).toEqual({ type: 'interrupt' });
  });

  it('decodes an ArrayBuffer frame the same as the equivalent Buffer', () => {
    const buf = Buffer.from('{"type":"interrupt"}');
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    expect(parseWsFrame(ab)).toEqual({ type: 'interrupt' });
  });

  it('concatenates a Buffer[] fragmented frame rather than joining with commas', () => {
    // `String([Buffer.from('{"type":"in'), Buffer.from('terrupt"}')])` would produce
    // `{"type":"in,terrupt"}` (Array.prototype.toString joins with ','), which is
    // syntactically valid-looking but semantically wrong JSON.
    const fragments = [Buffer.from('{"type":"in'), Buffer.from('terrupt"}')];
    expect(parseWsFrame(fragments)).toEqual({ type: 'interrupt' });
  });
});

describe('handleNotificationsMessage', () => {
  function deps() {
    return { queue: { decide: vi.fn() } } satisfies NotificationsMessageDeps;
  }

  for (const body of NON_OBJECT_FRAMES) {
    it(`does not throw and is a no-op for a "${body}" frame`, () => {
      const d = deps();
      expect(() => handleNotificationsMessage(Buffer.from(body), d)).not.toThrow();
      expect(d.queue.decide).not.toHaveBeenCalled();
    });
  }

  it('does not throw for unparsable JSON', () => {
    const d = deps();
    expect(() => handleNotificationsMessage(Buffer.from('{not json'), d)).not.toThrow();
    expect(d.queue.decide).not.toHaveBeenCalled();
  });

  it('dispatches approval_decide to the queue', () => {
    const d = deps();
    const raw = Buffer.from(JSON.stringify({ type: 'approval_decide', approvalId: 'a1', decision: 'allow' }));
    handleNotificationsMessage(raw, d);
    expect(d.queue.decide).toHaveBeenCalledWith('a1', { allow: true, reason: undefined });
  });

  it('ignores an unrecognized message type', () => {
    const d = deps();
    const raw = Buffer.from(JSON.stringify({ type: 'something_else' }));
    handleNotificationsMessage(raw, d);
    expect(d.queue.decide).not.toHaveBeenCalled();
  });
});

describe('handleSessionMessage', () => {
  function deps() {
    return {
      queue: { decide: vi.fn() },
      manager: { sendTurn: vi.fn(), interrupt: vi.fn(), broadcast: vi.fn(), isLive: vi.fn(() => true), wake: vi.fn(async () => {}) },
      modes: { set: vi.fn() },
    } satisfies SessionMessageDeps;
  }

  for (const body of NON_OBJECT_FRAMES) {
    it(`does not throw and is a no-op for a "${body}" frame`, () => {
      const d = deps();
      expect(() => handleSessionMessage(Buffer.from(body), 's1', d)).not.toThrow();
      expect(d.manager.sendTurn).not.toHaveBeenCalled();
      expect(d.manager.interrupt).not.toHaveBeenCalled();
      expect(d.manager.broadcast).not.toHaveBeenCalled();
      expect(d.queue.decide).not.toHaveBeenCalled();
    });
  }

  it('forwards user_message content to manager.sendTurn', () => {
    const d = deps();
    const raw = Buffer.from(JSON.stringify({ type: 'user_message', content: 'hi' }));
    handleSessionMessage(raw, 's1', d);
    expect(d.manager.sendTurn).toHaveBeenCalledWith('s1', { text: 'hi' });
  });

  // SessionManager.send throws for a session that isn't active — reachable any time a
  // client types into a session whose subprocess exited. The throw used to unwind
  // through ws.on('message') and kill the daemon, taking every other session with it.
  it('does not rethrow when manager.sendTurn rejects an inactive session', () => {
    const d = deps();
    d.manager.sendTurn.mockImplementation(() => { throw new Error('session s1 not active'); });
    const raw = Buffer.from(JSON.stringify({ type: 'user_message', content: 'hi' }));
    expect(() => handleSessionMessage(raw, 's1', d)).not.toThrow();
  });

  it('does not rethrow when manager.interrupt throws', () => {
    const d = deps();
    d.manager.interrupt.mockImplementation(() => { throw new Error('session s1 not active'); });
    const raw = Buffer.from(JSON.stringify({ type: 'interrupt' }));
    expect(() => handleSessionMessage(raw, 's1', d)).not.toThrow();
  });

  it('dispatches approval_decide to the queue', () => {
    const d = deps();
    const raw = Buffer.from(JSON.stringify({ type: 'approval_decide', approvalId: 'a1', decision: 'deny', reason: 'no' }));
    handleSessionMessage(raw, 's1', d);
    expect(d.queue.decide).toHaveBeenCalledWith('a1', { allow: false, reason: 'no' });
  });

  it('forwards interrupt to manager.interrupt', () => {
    const d = deps();
    const raw = Buffer.from(JSON.stringify({ type: 'interrupt' }));
    handleSessionMessage(raw, 's1', d);
    expect(d.manager.interrupt).toHaveBeenCalledWith('s1');
  });

  it('sets and broadcasts a valid approval_mode_set', () => {
    const d = deps();
    const raw = Buffer.from(JSON.stringify({ type: 'approval_mode_set', mode: 'plan' }));
    handleSessionMessage(raw, 's1', d);
    expect(d.modes.set).toHaveBeenCalledWith('s1', 'plan');
    expect(d.manager.broadcast).toHaveBeenCalledWith('s1', { type: 'approval_mode', sessionId: 's1', mode: 'plan' });
  });

  it('does not broadcast when modes.set rejects an invalid mode', () => {
    const d = deps();
    d.modes.set.mockImplementation(() => { throw new Error('invalid mode'); });
    const raw = Buffer.from(JSON.stringify({ type: 'approval_mode_set', mode: 'nonsense' }));
    expect(() => handleSessionMessage(raw, 's1', d)).not.toThrow();
    expect(d.manager.broadcast).not.toHaveBeenCalled();
  });

  it('ignores approval_mode_set with a non-string mode', () => {
    const d = deps();
    const raw = Buffer.from(JSON.stringify({ type: 'approval_mode_set', mode: 42 }));
    handleSessionMessage(raw, 's1', d);
    expect(d.modes.set).not.toHaveBeenCalled();
  });
});

describe('handleSessionMessage — engagement', () => {
  const deps = () => ({
    queue: { decide: vi.fn() },
    manager: { sendTurn: vi.fn(), interrupt: vi.fn(), broadcast: vi.fn(), isLive: vi.fn(() => true), wake: vi.fn(async () => {}) },
    modes: { set: vi.fn() },
    onUserMessage: vi.fn(),
  });
  const userMessage = Buffer.from(JSON.stringify({ type: 'user_message', content: 'hi' }));

  it('reports a delivered user message', () => {
    const d = deps();
    handleSessionMessage(userMessage, 's1', d);
    expect(d.onUserMessage).toHaveBeenCalledWith('s1');
  });

  it('does not report a message the manager refused', () => {
    const d = deps();
    d.manager.sendTurn.mockImplementation(() => { throw new Error('not active'); });
    handleSessionMessage(userMessage, 's1', d);
    expect(d.onUserMessage).not.toHaveBeenCalled();
  });
});

describe('handleSessionMessage — waking', () => {
  const deps = (active: boolean) => {
    const calls: string[] = [];
    return {
      calls,
      d: {
        queue: { decide: vi.fn() },
        manager: {
          sendTurn: vi.fn(() => { calls.push('send'); }),
          interrupt: vi.fn(),
          broadcast: vi.fn(),
          isLive: vi.fn(() => active),
          wake: vi.fn(async () => { calls.push('wake'); }),
        },
        modes: { set: vi.fn() },
        reply: vi.fn(),
        shell: { drain: () => '', restore: vi.fn(), run: vi.fn(async () => {}) },
      },
    };
  };
  const frame = (o: object) => Buffer.from(JSON.stringify(o));

  it('user_message to a non-live session wakes then sends', async () => {
    const { d, calls } = deps(false);
    handleSessionMessage(frame({ type: 'user_message', content: 'hi' }), 's1', d);
    await vi.waitFor(() => expect(calls).toEqual(['wake', 'send']));
  });

  it('a wake frame calls manager.wake', () => {
    const { d } = deps(false);
    handleSessionMessage(frame({ type: 'wake' }), 's1', d);
    expect(d.manager.wake).toHaveBeenCalledWith('s1');
  });

  it('replies a wake failure as daemon_error without throwing', async () => {
    const { d } = deps(false);
    d.manager.wake.mockImplementation(async () => { throw new Error('no transcript'); });
    expect(() => handleSessionMessage(frame({ type: 'wake' }), 's1', d)).not.toThrow();
    await vi.waitFor(() => expect(d.reply).toHaveBeenCalledWith({ type: 'daemon_error', message: 'no transcript' }));
  });

  it('refuses a user_message whose wake fails to every viewer, echoing its clientId', async () => {
    const { d } = deps(false);
    d.manager.wake.mockImplementation(async () => { throw new Error('no transcript'); });
    handleSessionMessage(frame({ type: 'user_message', content: 'hi', clientId: 'c1' }), 's1', d);
    await vi.waitFor(() => expect(d.manager.broadcast).toHaveBeenCalledWith('s1', { type: 'daemon_error', message: 'Message not sent — no transcript', clientId: 'c1' }));
    expect(d.manager.sendTurn).not.toHaveBeenCalled();
  });

  it('a shell command runs once the session is awake', async () => {
    const { d, calls } = deps(false);
    d.manager.wake.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 0)); calls.push('wake'); });
    d.shell.run.mockImplementation(async () => { calls.push('run'); });
    handleSessionMessage(frame({ type: 'shell_exec', execId: 'e1', command: 'ls' }), 's1', d);
    await vi.waitFor(() => expect(calls).toEqual(['wake', 'run']));
  });

  it('a shell command still runs, and reports, when the wake fails', async () => {
    const { d } = deps(false);
    d.manager.wake.mockImplementation(async () => { throw new Error('no transcript'); });
    handleSessionMessage(frame({ type: 'shell_exec', execId: 'e1', command: 'ls' }), 's1', d);
    await vi.waitFor(() => expect(d.shell.run).toHaveBeenCalledWith('s1', 'e1', 'ls'));
  });
});
