import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A worktree-mode session spawns only after the worktree is built, which for a repo with a big
// node_modules took 12s — while the PWA's socket was already open and its composer live. A first
// message typed in that window reached send() before the session was in `active` and was
// refused ("session … not active") even though its subprocess appeared seconds later.

const sends: { sessionId: string; message: unknown }[] = [];

vi.mock('../../src/session/claude-proc.js', () => ({
  ClaudeProc: class {
    constructor(private opts: { sessionId: string }) {}
    send(message: unknown): void { sends.push({ sessionId: this.opts.sessionId, message }); }
    interrupt(): void {}
    async kill(): Promise<void> {}
  },
}));

const { SessionManager } = await import('../../src/session/session-manager.js');
const { SessionStore } = await import('../../src/session/session-store.js');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'outpost-pending-send-'));
  let finish!: (rec: { worktreePath: string }) => void;
  let fail!: (e: Error) => void;
  const worktreeManager = {
    get: () => undefined,
    create: () => new Promise<{ worktreePath: string }>((res, rej) => { finish = res; fail = rej; }),
  };
  const manager = new SessionManager({
    settingsPath: '/tmp/settings.json',
    mcpConfigPath: '/tmp/mcp.json',
    daemonAuthSecret: 'secret',
    daemonHost: '127.0.0.1',
    hookPort: 1,
    sessionStore: new SessionStore({ root: join(dir, 'projects'), sessionMetaDir: join(dir, 'session-meta') }),
    worktreeManager: worktreeManager as never,
  });
  const frames: Record<string, unknown>[] = [];
  const ws = { send: (raw: string) => frames.push(JSON.parse(raw)), close: () => {}, on: () => {} } as never;
  manager.attach('wt-1', ws, { cwd: dir, spawnMode: 'worktree', baseBranch: 'main' });
  return { manager, dir, frames, finish: (p: string) => finish({ worktreePath: p }), fail: (e: Error) => fail(e) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const msg = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });

describe('send while a worktree spawn is pending', () => {
  beforeEach(() => { sends.length = 0; });

  it('holds the message and delivers it once the session spawns', async () => {
    const { manager, dir, finish } = setup();
    expect(() => manager.send('wt-1', msg('first'))).not.toThrow();
    expect(() => manager.send('wt-1', msg('second'))).not.toThrow();
    expect(sends).toEqual([]);

    finish(dir);
    await flush();
    expect(sends.map((s) => s.message)).toEqual([msg('first'), msg('second')]);
    expect(manager.isWorking('wt-1')).toBe(true);
  });

  it('drops held messages when the worktree cannot be built, and stops holding', async () => {
    const { manager, frames, fail } = setup();
    manager.send('wt-1', msg('lost'));
    fail(new Error('boom'));
    await flush();
    expect(sends).toEqual([]);
    expect(frames.at(-1)).toMatchObject({ type: 'daemon_error', fatal: true });
    expect(() => manager.send('wt-1', msg('later'))).toThrow(/not active/);
  });
});
