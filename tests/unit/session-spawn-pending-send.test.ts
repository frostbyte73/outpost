import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A worktree-mode session spawns only after its worktree is built, while the PWA's socket is
// already open. Messages sent in that window are held and delivered once it spawns, and a
// reconnect joins the build already running instead of starting a second one.

const spawned: string[] = [];
const sends: unknown[] = [];

vi.mock('../../src/session/claude-proc.js', () => ({
  ClaudeProc: class {
    constructor(opts: { sessionId: string }) { spawned.push(opts.sessionId); }
    send(message: unknown): void { sends.push(message); }
    interrupt(): void {}
    async kill(): Promise<void> {}
  },
}));

const { SessionManager } = await import('../../src/session/session-manager.js');
const { SessionStore } = await import('../../src/session/session-store.js');
const { handleSessionMessage } = await import('../../src/ws/client-messages.js');

type Frame = Record<string, unknown>;

function fakeWs() {
  const frames: Frame[] = [];
  const ws = {
    readyState: 1,
    send: (raw: string) => frames.push(JSON.parse(raw)),
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
    settingsPath: '/tmp/settings.json',
    mcpConfigPath: '/tmp/mcp.json',
    daemonAuthSecret: 'secret',
    daemonHost: '127.0.0.1',
    hookPort: 1,
    sessionStore: new SessionStore({ root: join(dir, 'projects'), sessionMetaDir: join(dir, 'session-meta') }),
    worktreeManager: { get: () => undefined, create } as never,
  });
  const attach = () => {
    const sock = fakeWs();
    manager.attach('wt-1', sock.ws as never, { cwd: dir, spawnMode: 'worktree', baseBranch: 'main' });
    return sock;
  };
  // The path the PWA's composer actually takes, refusal and all.
  const userMessage = (text: string, clientId: string) => {
    const replies: Frame[] = [];
    handleSessionMessage(Buffer.from(JSON.stringify({ type: 'user_message', content: text, clientId })), 'wt-1', {
      queue: {} as never, modes: {} as never, manager, reply: (m) => replies.push(m as Frame),
    });
    return replies;
  };
  return { manager, create, attach, userMessage, finish: () => finish(), fail: (e: Error) => fail(e) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const userTexts = () => sends.map((m) => (m as { message: { content: unknown } }).message.content);
const sessionStates = (frames: Frame[]) => frames.filter((f) => f.type === 'session_state');

describe('a worktree session whose spawn is still pending', () => {
  beforeEach(() => { spawned.length = 0; sends.length = 0; });

  it('holds messages and delivers them in order once the session spawns', async () => {
    const t = setup();
    const sock = t.attach();
    expect(t.userMessage('first', 'c1')).toEqual([]);
    expect(t.userMessage('second', 'c2')).toEqual([]);
    expect(sends).toEqual([]);

    t.finish();
    await flush();
    expect(userTexts()).toEqual(['first', 'second']);
    // Delivered before the socket attached, so the client isn't told the session is idle
    expect(sessionStates(sock.frames)).toEqual([expect.objectContaining({ working: true })]);
    // No longer pending: the next message goes straight through
    t.userMessage('third', 'c3');
    expect(userTexts()).toEqual(['first', 'second', 'third']);
  });

  it('folds a reconnect into the build already running', async () => {
    const t = setup();
    const first = t.attach();
    t.userMessage('before reconnect', 'c1');
    first.ws.close();
    const second = t.attach();
    t.userMessage('after reconnect', 'c2');

    t.finish();
    await flush();
    expect(t.create).toHaveBeenCalledTimes(1);
    expect(spawned).toEqual(['wt-1']);
    expect(userTexts()).toEqual(['before reconnect', 'after reconnect']);
    // The socket that closed mid-build is never attached — its close handler would never fire
    expect(sessionStates(first.frames)).toEqual([]);
    expect(sessionStates(second.frames)).toHaveLength(1);
  });

  it('attaches every socket still open when the build finishes', async () => {
    const t = setup();
    const a = t.attach();
    const b = t.attach();
    t.finish();
    await flush();
    expect(sessionStates(a.frames)).toHaveLength(1);
    expect(sessionStates(b.frames)).toHaveLength(1);
  });

  it('refuses each held message with its clientId when the build fails, then stops holding', async () => {
    const t = setup();
    const a = t.attach();
    const b = t.attach();
    const r1 = t.userMessage('one', 'c1');
    const r2 = t.userMessage('two', 'c2');

    t.fail(new Error('boom'));
    await flush();
    expect(spawned).toEqual([]);
    expect(r1).toEqual([expect.objectContaining({ type: 'daemon_error', clientId: 'c1', message: expect.stringContaining('boom') })]);
    expect(r2).toEqual([expect.objectContaining({ type: 'daemon_error', clientId: 'c2' })]);
    for (const sock of [a, b]) {
      expect(sock.frames.at(-1)).toMatchObject({ type: 'daemon_error', fatal: true, message: 'worktree creation failed: boom' });
    }
    expect(t.userMessage('later', 'c3')).toEqual([expect.objectContaining({ clientId: 'c3', message: expect.stringMatching(/not active/) })]);
  });
});
