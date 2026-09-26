import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A step session's `$OUTPOST_ENVELOPE` has to survive a respawn through ANY door, because the
// door the user walks through is the one that drops it: attach() (the PWA opening the session)
// spawns with no env, and sendOrResume applies env only when it has to spawn. CS-2068's step
// died on exactly that order — the user opened the session to read its gate question, the
// gate denial then resumed an already-live env-less proc, and the controller woke blind
// (`printenv OUTPOST_ENVELOPE` → exit 1) and ended the turn without a move.

const spawned: { sessionId: string; env: Record<string, string> }[] = [];

vi.mock('../../src/session/claude-proc.js', () => ({
  ClaudeProc: class {
    constructor(opts: { sessionId: string; env: Record<string, string> }) {
      spawned.push({ sessionId: opts.sessionId, env: opts.env });
    }
    send(): void {}
    interrupt(): void {}
    async kill(): Promise<void> {}
  },
}));

const { SessionManager } = await import('../../src/session/session-manager.js');
const { SessionStore } = await import('../../src/session/session-store.js');

const STEP_ENV = {
  OUTPOST_ENVELOPE: '/Users/dc/.outpost/jobs/CS-2068/steps/19531999/envelope.json',
  JOB_ID: 'CS-2068',
  STEP_ID: '19531999',
  STEP_TYPE: 'orchestrated',
};

function newManager() {
  const dir = mkdtempSync(join(tmpdir(), 'outpost-spawn-env-'));
  const store = new SessionStore({ root: join(dir, 'projects'), sessionMetaDir: join(dir, 'session-meta') });
  const manager = new SessionManager({
    settingsPath: '/tmp/settings.json',
    mcpConfigPath: '/tmp/mcp.json',
    daemonAuthSecret: 'secret',
    daemonHost: '127.0.0.1',
    hookPort: 1,
    sessionStore: store,
  });
  return { manager, store, cwd: dir };
}

function fakeWs(): never {
  return { send: () => {}, close: () => {}, on: () => {} } as never;
}

describe('spawn env stickiness', () => {
  beforeEach(() => { spawned.length = 0; });

  it('re-applies the step env when the PWA respawns a reaped session', async () => {
    const { manager, cwd } = newManager();
    manager.spawnDetached('step-1', cwd, STEP_ENV);
    await manager.close('step-1', 'idle');

    manager.attach('step-1', fakeWs(), { cwd });

    expect(spawned).toHaveLength(2);
    expect(spawned[1]!.env).toMatchObject(STEP_ENV);
  });

  // The failure itself: once the PWA has the proc alive again, sendOrResume never respawns,
  // so a resume can only ever reach the env that attach() gave it.
  it('leaves a PWA-respawned session holding its envelope for the next resume', async () => {
    const { manager, cwd } = newManager();
    manager.spawnDetached('step-1', cwd, STEP_ENV);
    await manager.close('step-1', 'idle');
    manager.attach('step-1', fakeWs(), { cwd });

    manager.sendOrResume('step-1', cwd, { type: 'user' }, STEP_ENV);

    expect(spawned).toHaveLength(2);
    expect(spawned.at(-1)!.env).toMatchObject(STEP_ENV);
  });

  // The action-meta sidecar shares this file and is written right after the spawn.
  it('keeps the persisted env when action meta is stamped onto the same session', async () => {
    const { manager, store, cwd } = newManager();
    manager.spawnDetached('step-1', cwd, STEP_ENV);
    store.writeActionMeta('step-1', { action: 'code.orchestrate-pr', title: 'A step' });
    await manager.close('step-1', 'idle');

    manager.attach('step-1', fakeWs(), { cwd });

    expect(spawned.at(-1)!.env).toMatchObject(STEP_ENV);
  });

  // Only the daemon's own per-session vars belong on disk — never the hook secret.
  it('persists the step env and nothing else', () => {
    const { manager, store, cwd } = newManager();
    manager.spawnDetached('step-1', cwd, STEP_ENV);
    expect(store.readSpawnEnv('step-1')).toEqual(STEP_ENV);
  });

  it('leaves a plain interactive session with no step env', () => {
    const { manager, cwd } = newManager();
    manager.attach('chat-1', fakeWs(), { cwd });
    expect(spawned[0]!.env.OUTPOST_ENVELOPE).toBeUndefined();
  });
});
