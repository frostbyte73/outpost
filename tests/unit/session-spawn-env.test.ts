import { describe, it, expect, beforeEach } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../../src/session/session-manager.js';
import { SessionStore } from '../../src/session/session-store.js';
import { ClaudeTranscripts } from '../../src/runtime/claude/transcripts.js';
import { RuntimeRegistry } from '../../src/runtime/registry.js';
import { CompositeTranscripts } from '../../src/runtime/transcripts.js';
import { JsonlTranscripts } from '../../src/runtime/jsonl-transcripts.js';
import type { AgentRuntime, StartCallbacks, StartOpts } from '../../src/runtime/types.js';

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

it('continues one transcript across a cold runtime switch and a return to Claude', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'outpost-handoff-'));
  const claude = new ClaudeTranscripts(join(cwd, 'claude'));
  const codex = new JsonlTranscripts(join(cwd, 'codex'));
  const launches: { opts: StartOpts; callbacks: StartCallbacks }[] = [];
  const sent: { token: string; block: string }[] = [];
  const adapter = (id: string, transcripts: AgentRuntime['transcripts']) => ({
    id, available: true, transcripts,
    start(opts, callbacks) {
      launches.push({ opts, callbacks });
      return {
        sendTurn(turn, seed) {
          if (seed) sent.push(seed);
          const transcriptId = opts.transcriptId ?? opts.sessionId;
          if (id === 'claude') {
            const dir = claude.projectDirFor(cwd);
            mkdirSync(dir, { recursive: true });
            appendFileSync(join(dir, `${transcriptId}.jsonl`), JSON.stringify({
              cwd, type: 'user', message: { role: 'user', content: [
                { type: 'text', text: turn.text },
                ...(seed ? [{ type: 'text', text: seed.block }] : []),
              ] },
            }) + '\n');
          } else {
            codex.append(transcriptId, cwd, { id: 'u1', type: 'user_message', text: turn.text });
          }
          if (seed) callbacks.onSeedAccepted?.(seed.token);
        },
        interrupt() {},
        async kill() {},
      };
    },
  } satisfies Pick<AgentRuntime, 'id' | 'available' | 'transcripts' | 'start'>) as AgentRuntime;
  const registry = new RuntimeRegistry(adapter('claude', claude), [adapter('codex', codex)]);
  const reopen = () => {
    const store = new SessionStore({
      transcripts: new CompositeTranscripts(claude, [{ root: codex.root, reader: codex }]),
      sessionMetaDir: join(cwd, 'meta'),
    });
    return { store, manager: new SessionManager({ runtimes: registry, sessionStore: store }) };
  };
  const first = reopen();
  first.manager.sendOrResume('chat-1', cwd, { text: 'First prompt' });
  await first.manager.switchRuntime('chat-1', 'codex', 'chat-1', () => {});
  expect(first.manager.acceptsWorkSubmission('chat-1', launches[0]!.opts.launchCredential)).toBe(false);

  const resumed = reopen();
  resumed.manager.attach('chat-1', fakeWs(), { runtime: 'claude' });
  await resumed.manager.wake('chat-1');
  expect(launches[1]!.opts).toMatchObject({ mode: 'new', sessionId: 'chat-1' });
  expect(resumed.store.currentSegment('chat-1')?.seedPending).toBe(true);
  resumed.manager.sendTurn('chat-1', { text: 'Second prompt' });
  expect(sent[0]?.block).toContain('First prompt');
  expect(resumed.store.currentSegment('chat-1')?.seedPending).toBe(false);
  await resumed.manager.switchRuntime('chat-1', 'claude', resumed.manager.runtimeVersion('chat-1'), () => {});
  launches[1]!.opts.saveNativeId?.('retired-native-id');
  launches[1]!.callbacks.onSeedAccepted?.(sent[0]!.token);
  expect(resumed.store.currentSegment('chat-1')).toMatchObject({ runtime: 'claude', seedPending: true });
  expect(resumed.store.currentSegment('chat-1')?.nativeId).toBeUndefined();
  resumed.manager.sendOrResume('chat-1', cwd, { text: 'Third prompt' });
  launches[1]!.callbacks.onExit(1);
  expect(launches[1]!.opts.canStartTool?.()).toBe(false);
  expect(resumed.manager.isWorking('chat-1')).toBe(true);
  expect(resumed.manager.acceptsWorkSubmission('chat-1', launches[2]!.opts.launchCredential)).toBe(true);
  expect(launches[2]!.opts.transcriptId).not.toBe('chat-1');
  expect(sent[1]?.block).toContain('Second prompt');
  expect(resumed.store.readItems('chat-1').map((item) => 'text' in item && item.text))
    .toEqual(['First prompt', 'Second prompt', 'Third prompt']);
  await resumed.manager.close('chat-1');
});
