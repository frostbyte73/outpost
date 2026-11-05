import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../../src/session/session-manager.js';
import { SessionStore } from '../../src/session/session-store.js';
import { ClaudeTranscripts } from '../../src/runtime/claude/transcripts.js';
import { RuntimeRegistry } from '../../src/runtime/registry.js';
import type { AgentRuntime, StartOpts } from '../../src/runtime/types.js';

// A step session's `$OUTPOST_ENVELOPE` has to survive a respawn through ANY door, because the
// door the user walks through is the one that drops it: wake() (the PWA resuming the session)
// spawns with no env, and sendOrResume applies env only when it has to spawn. CS-2068's step
// died on exactly that order — the user opened the session to read its gate question, the
// gate denial then resumed an already-live env-less proc, and the controller woke blind
// (`printenv OUTPOST_ENVELOPE` → exit 1) and ended the turn without a move.

const spawned: StartOpts[] = [];

const runtime = {
  start(opts: StartOpts) {
    spawned.push(opts);
    return { sendTurn() {}, interrupt() {}, async kill() {} };
  },
} as unknown as AgentRuntime;

const STEP_ENV = {
  OUTPOST_ENVELOPE: '/Users/testuser/.outpost/jobs/CS-2068/steps/19531999/envelope.json',
  JOB_ID: 'CS-2068',
  STEP_ID: '19531999',
  STEP_TYPE: 'orchestrated',
};

function newManager() {
  const dir = mkdtempSync(join(tmpdir(), 'outpost-spawn-env-'));
  const store = new SessionStore({ transcripts: new ClaudeTranscripts(join(dir, 'projects')), sessionMetaDir: join(dir, 'session-meta') });
  const manager = new SessionManager({ runtimes: new RuntimeRegistry(runtime), sessionStore: store });
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
    await manager.wake('step-1');

    expect(spawned).toHaveLength(2);
    expect(spawned[1]!.env).toMatchObject(STEP_ENV);
  });

  // The failure itself: once the PWA has the proc alive again, sendOrResume never respawns,
  // so a resume can only ever reach the env that wake() gave it.
  it('leaves a PWA-respawned session holding its envelope for the next resume', async () => {
    const { manager, cwd } = newManager();
    manager.spawnDetached('step-1', cwd, STEP_ENV);
    await manager.close('step-1', 'idle');
    manager.attach('step-1', fakeWs(), { cwd });
    await manager.wake('step-1');

    manager.sendOrResume('step-1', cwd, { text: '' }, STEP_ENV);

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
    await manager.wake('step-1');

    expect(spawned.at(-1)!.env).toMatchObject(STEP_ENV);
  });

  // Only the daemon's own per-session vars belong on disk — never the hook secret.
  it('persists the step env and nothing else', () => {
    const { manager, store, cwd } = newManager();
    manager.spawnDetached('step-1', cwd, STEP_ENV);
    expect(store.readSpawnEnv('step-1')).toEqual(STEP_ENV);
  });

  it('leaves a plain interactive session with no step env', async () => {
    const { manager, cwd } = newManager();
    manager.attach('chat-1', fakeWs(), { cwd });
    await manager.wake('chat-1');
    expect(spawned[0]!.env.OUTPOST_ENVELOPE).toBeUndefined();
  });
});

describe('system prompt stickiness', () => {
  beforeEach(() => { spawned.length = 0; });

  it('passes a persisted system prompt on the first wake and on a respawn after reap', async () => {
    const { manager, store, cwd } = newManager();
    store.writeSystemPrompt('wait-1', 'job context');

    manager.attach('wait-1', fakeWs(), { cwd });
    await manager.wake('wait-1');
    await manager.close('wait-1', 'idle');
    manager.attach('wait-1', fakeWs(), { cwd });
    await manager.wake('wait-1');

    expect(spawned.map((s) => s.appendSystemPrompt)).toEqual(['job context', 'job context']);
  });

  it('keeps the spawn env when the system prompt is written alongside it', () => {
    const { manager, store, cwd } = newManager();
    manager.spawnDetached('step-1', cwd, STEP_ENV);
    store.writeSystemPrompt('step-1', 'ctx');
    expect(store.readSpawnEnv('step-1')).toEqual(STEP_ENV);
    expect(store.readSystemPrompt('step-1')).toBe('ctx');
  });

  it('passes no system prompt for a session that never had one', async () => {
    const { manager, cwd } = newManager();
    manager.attach('chat-1', fakeWs(), { cwd });
    await manager.wake('chat-1');
    expect(spawned[0]!.appendSystemPrompt).toBeUndefined();
  });
});
