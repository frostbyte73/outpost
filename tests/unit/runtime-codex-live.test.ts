import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookServer } from '../../src/permissions/hook-server.js';
import { codexVersion, resolveCodexBin } from '../../src/runtime/codex/bin.js';
import { CodexRuntime } from '../../src/runtime/codex/runtime.js';
import { CodexTranscripts } from '../../src/runtime/codex/transcripts.js';
import type { CanonicalEvent, GateDecision, GateRequest, RuntimeHost, RuntimeSession } from '../../src/runtime/types.js';

const bin = process.env.OUTPOST_CODEX_LIVE ? resolveCodexBin() : null;
const PORT = 20_000 + Math.floor(Math.random() * 20_000);
const SECRET = 'live-test-secret';

// Against a real `codex app-server`: the hook loads trusted, reaches the gate, and blocks when the gate is gone.
describe.skipIf(!bin || !codexVersion(bin))('Codex runtime (live)', () => {
  const gated: GateRequest[] = [];
  let decide: (r: GateRequest) => GateDecision = () => ({ allow: true });
  let hookServer: HookServer | undefined;
  let session: RuntimeSession | undefined;

  const host: RuntimeHost = {
    gateToolCall: async (r) => { gated.push(r); return decide(r); },
    onToolFailed: () => {}, onToolCompleted: () => {}, onTurnEnded: () => {}, onTurnFailed: () => {}, onUsage: () => {},
  };
  const dir = mkdtempSync(join(tmpdir(), 'outpost-codex-live-'));
  const runtime = new CodexRuntime({
    bin, host: () => host, mcpServers: () => new Map(),
    approvalTimeoutMs: 60_000, daemonAuthSecret: SECRET, hookPort: PORT,
    transcripts: new CodexTranscripts(join(dir, 'transcripts')),
    nativeIds: { read: () => null, write: () => {} },
    actionBody: () => undefined,
  });

  async function listen(): Promise<void> {
    hookServer = new HookServer({
      port: PORT, daemonAuthSecret: SECRET,
      onWorkPlanReady: async () => {}, onWorkStepResolved: async () => {}, onWorkStepFailed: async () => {},
      onActionProposal: async () => {}, onWorkJournal: async () => {},
      onMcp: async () => ({ status: 404, headers: {}, body: '' }),
      onCodexPreTool: (b) => runtime.handlePreToolUse(b),
    });
    await hookServer.listen();
  }

  function runTurn(text: string): Promise<CanonicalEvent[]> {
    const events: CanonicalEvent[] = [];
    return new Promise((resolve, reject) => {
      session = runtime.start(
        { sessionId: `live-${Date.now()}`, mode: 'new', cwd: dir, env: {}, isAction: true },
        {
          onEvent: (e) => { events.push(e); if (e.type === 'turn.completed') resolve(events); },
          onError: () => {},
          onExit: (code) => reject(new Error(`codex exited ${code} before the turn ended`)),
        },
      );
      session.sendTurn({ text });
    });
  }

  afterEach(async () => {
    await session?.kill();
    await hookServer?.close();
    hookServer = undefined;
    gated.length = 0;
    decide = () => ({ allow: true });
  });

  it('routes a shell call through the gate, and a deny keeps it from running', async () => {
    await listen();
    decide = () => ({ allow: false, reason: 'live test deny' });
    const events = await runTurn('Run the shell command `echo outpost-live-marker` and tell me its output.');
    expect(gated.some((r) => r.tool === 'shell')).toBe(true);
    const outputs = events.flatMap((e) => (e.type === 'item.completed' && e.item.type === 'tool_call' ? [e.item.resultText ?? ''] : []));
    expect(outputs.join('\n')).not.toContain('outpost-live-marker');
  }, 180_000);

  it('blocks the call when the hook endpoint is down', async () => {
    const events = await runTurn('Run the shell command `echo outpost-live-marker` and tell me its output.');
    const outputs = events.flatMap((e) => (e.type === 'item.completed' && e.item.type === 'tool_call' ? [e.item.resultText ?? ''] : []));
    expect(outputs.join('\n')).not.toContain('outpost-live-marker');
    expect(gated).toEqual([]);
  }, 180_000);
});
