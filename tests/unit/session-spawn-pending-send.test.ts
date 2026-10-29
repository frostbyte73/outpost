import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../../src/session/session-manager.js';
import { SessionStore } from '../../src/session/session-store.js';
import { handleSessionMessage } from '../../src/ws/client-messages.js';
import { ClaudeTranscripts } from '../../src/runtime/claude/transcripts.js';
import type { AgentRuntime, StartOpts, TurnInput } from '../../src/runtime/types.js';

const spawned: string[] = [];
const sends: TurnInput[] = [];

const runtime = {
  start(opts: StartOpts) {
    spawned.push(opts.sessionId);
    return { sendTurn: (t: TurnInput) => { sends.push(t); }, interrupt() {}, async kill() {} };
  },
} as unknown as AgentRuntime;

type Frame = Record<string, unknown>;
type Sock = ReturnType<typeof fakeWs>;

// Like `ws`, a send on a closed socket is silently dropped rather than thrown.
function fakeWs() {
  const frames: Frame[] = [];
  const ws = {
    readyState: 1,
    send: (raw: string) => { if (ws.readyState === 1) frames.push(JSON.parse(raw)); },
    close: () => { ws.readyState = 3; },
    on: () => {},
  };
  return { ws, frames };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'outpost-pending-send-'));
  let finish!: () => void;
  let fail!: (e: Error) => void;
  const create = vi.fn(() => new Promise<{ worktreePath: string }>((res, rej) => {
    finish = () => res({ worktreePath: dir });
    fail = rej;
  }));
  const manager = new SessionManager({
    runtime,
    sessionStore: new SessionStore({ transcripts: new ClaudeTranscripts(join(dir, 'projects')), sessionMetaDir: join(dir, 'session-meta') }),
    worktreeManager: { get: () => undefined, create } as never,
  });
  const attach = () => {
    const sock = fakeWs();
    manager.attach('wt-1', sock.ws as never, { cwd: dir, spawnMode: 'worktree', baseBranch: 'main' });
    return sock;
  };
  // Wired as daemon.ts wires it: a refusal replies on the socket the message arrived on.
  const userMessage = (sock: Sock, text: string, clientId: string) => {
    handleSessionMessage(Buffer.from(JSON.stringify({ type: 'user_message', content: text, clientId })), 'wt-1', {
      queue: {} as never, modes: {} as never, manager, reply: (m) => sock.ws.send(JSON.stringify(m)),
    });
  };
  // The build starts a tick after the message, once wake() reaches it
  return {
    create, attach, userMessage,
    finish: async () => { await flush(); finish(); },
    fail: async (e: Error) => { await flush(); fail(e); },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const userTexts = () => sends.map((t) => t.text);
const ofType = (frames: Frame[], type: string) => frames.filter((f) => f.type === type);
const refusals = (frames: Frame[]) => ofType(frames, 'daemon_error').filter((f) => f.clientId);

describe('a worktree session whose spawn is still pending', () => {
  beforeEach(() => { spawned.length = 0; sends.length = 0; });

  it('holds messages and delivers them in order once the session spawns', async () => {
    const t = setup();
    const sock = t.attach();
    t.userMessage(sock, 'first', 'c1');
    t.userMessage(sock, 'second', 'c2');
    expect(sends).toEqual([]);
    expect(refusals(sock.frames)).toEqual([]);

    await t.finish();
    await flush();
    expect(userTexts()).toEqual(['first', 'second']);
    expect(ofType(sock.frames, 'session_state').map((f) => f.live)).toEqual([false, true]);
    t.userMessage(sock, 'third', 'c3');
    expect(userTexts()).toEqual(['first', 'second', 'third']);
  });

  it('folds a reconnect into the build already running', async () => {
    const t = setup();
    const first = t.attach();
    t.userMessage(first, 'before reconnect', 'c1');
    first.ws.close();
    const second = t.attach();
    t.userMessage(second, 'after reconnect', 'c2');

    await t.finish();
    await flush();
    expect(t.create).toHaveBeenCalledTimes(1);
    expect(spawned).toEqual(['wt-1']);
    expect(userTexts()).toEqual(['before reconnect', 'after reconnect']);
    expect(ofType(second.frames, 'session_state').map((f) => f.live)).toEqual([false, true]);
  });

  it('promotes every socket still watching when the build finishes', async () => {
    const t = setup();
    const a = t.attach();
    const b = t.attach();
    t.userMessage(a, 'go', 'c1');
    await t.finish();
    await flush();
    expect(ofType(a.frames, 'session_state').map((f) => f.live)).toEqual([false, true]);
    expect(ofType(b.frames, 'session_state').map((f) => f.live)).toEqual([false, true]);
  });

  it('refuses each held message with its clientId when the build fails, and retries on the next message', async () => {
    const t = setup();
    const sock = t.attach();
    t.userMessage(sock, 'one', 'c1');
    t.userMessage(sock, 'two', 'c2');

    await t.fail(new Error('boom'));
    await flush();
    expect(spawned).toEqual([]);
    expect(refusals(sock.frames).map((f) => f.clientId)).toEqual(['c1', 'c2']);
    expect(refusals(sock.frames)[0]!.message).toContain('worktree creation failed: boom');

    const later = t.attach();
    t.userMessage(later, 'later', 'c3');
    await flush();
    expect(t.create).toHaveBeenCalledTimes(2);
  });

  it('delivers the refusal to the reconnected socket when the sender has since closed', async () => {
    const t = setup();
    const first = t.attach();
    t.userMessage(first, 'typed before the drop', 'c1');
    first.ws.close();
    const second = t.attach();

    await t.fail(new Error('boom'));
    await flush();
    expect(refusals(second.frames)).toEqual([expect.objectContaining({ clientId: 'c1' })]);
  });
});
