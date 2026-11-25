import { describe, it, expect } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HookServer } from '../../src/permissions/hook-server.js';
import { CURSOR_HOOK_COMMAND } from '../../src/runtime/cursor/hooks.js';
import { CursorRuntime } from '../../src/runtime/cursor/runtime.js';
import { JsonlTranscripts } from '../../src/runtime/jsonl-transcripts.js';
import type { GateRequest, RuntimeHost } from '../../src/runtime/types.js';
import { freePort } from '../e2e/harness/port.js';

const AGENT = fileURLToPath(new URL('./helpers/fake-cursor-agent.mjs', import.meta.url));

interface Run { gated: GateRequest[]; failures: string[]; stderr: string }

async function run(script: string, allow: (r: GateRequest) => boolean = () => true): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'outpost-cursor-'));
  const bin = join(dir, 'agent');
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${AGENT}"\n`);
  chmodSync(bin, 0o755);
  const out: Run = { gated: [], failures: [], stderr: '' };
  const host: RuntimeHost = {
    gateToolCall: async (r) => { out.gated.push(r); return allow(r) ? { allow: true } : { allow: false, reason: 'test deny' }; },
    onToolFailed: () => {}, onToolCompleted: () => {}, onUsage: () => {}, onTurnEnded: () => {},
    onTurnFailed: (_id, code) => { out.failures.push(code); },
  };
  const port = await freePort();
  const runtime = new CursorRuntime({
    bin, host: () => host, mcpServers: () => new Map(), approvalTimeoutMs: 60_000, daemonAuthSecret: 'sek', hookPort: port,
    runtimeDir: join(dir, 'runtime'), transcripts: new JsonlTranscripts(join(dir, 'transcripts')),
    nativeIds: { read: () => null, write: () => {} }, actionBody: () => undefined,
  });
  const noop = async () => {};
  const server = new HookServer({
    port, daemonAuthSecret: 'sek', onWorkPlanReady: noop, onWorkStepResolved: noop, onWorkStepFailed: noop,
    onActionProposal: noop, onWorkJournal: noop, onMcp: async () => ({ status: 404, headers: {}, body: '' }),
    onCursorHook: (body, session) => runtime.handleHook(body, session),
  });
  await server.listen();
  try {
    await new Promise<void>((resolve) => {
      const session = runtime.start({
        sessionId: `s-${script}`, mode: 'new', cwd: dir, isAction: true,
        env: { FAKE_CURSOR_SCRIPT: script, FAKE_CURSOR_HOOK_COMMAND: CURSOR_HOOK_COMMAND },
      }, {
        onEvent: (e) => { if (e.type === 'turn.completed') void session.kill().then(resolve); },
        onError: (m) => { out.stderr += m; },
        onExit: () => resolve(),
      });
      session.sendTurn({ text: 'go' });
    });
  } finally {
    await server.close();
  }
  return out;
}

// Shell and MCP hooks carry no ACP id and their request_permission comes after, so one decision must answer both.
describe('Cursor hook ledger', () => {
  it('gates a shell call once at its hook and answers the later request from that decision', async () => {
    const r = await run('shell');
    expect(r.gated.map((g) => g.tool)).toEqual(['shell']);
    expect(r.stderr).toContain('permission:{"outcome":{"outcome":"selected","optionId":"once"}}');
    expect(r.failures).not.toContain('ungated_tool_call');
  });

  it('rejects a request that no hook decided, without asking the gate', async () => {
    const r = await run('request-without-hook');
    expect(r.gated).toEqual([]);
    expect(r.stderr).toContain('permission:{"outcome":{"outcome":"selected","optionId":"no"}}');
  });

  it("decides an edit as a write at its Read hook and replays it for the Write hook", async () => {
    const r = await run('edit');
    expect(r.gated.map((g) => g.tool)).toEqual(['file_write']);
    expect((r.gated[0]!.input as { file_path: string }).file_path).toMatch(/\/a\.txt$/);
    expect(r.stderr).toContain('hook:Read:allow');
    expect(r.stderr).toContain('hook:Write:allow');
    expect(r.failures).not.toContain('ungated_tool_call');
  });

  it("denies an edit at its Read hook, since a Write-hook deny doesn't stop Cursor's edit", async () => {
    const r = await run('edit', (g) => g.tool !== 'file_write');
    expect(r.stderr).toContain('hook:Read:deny');
  });

  it('settles a hook-denied shell call without tripping, and the next identical call still gets its own allow', async () => {
    let shells = 0;
    const r = await run('shell-denied-then-allowed', (g) => g.tool !== 'shell' || ++shells > 1);
    expect(r.gated.map((g) => g.tool)).toEqual(['shell', 'shell']);
    expect(r.stderr).toContain('hook:Shell:deny');
    expect(r.stderr).toContain('permission:{"outcome":{"outcome":"selected","optionId":"once"}}');
    expect(r.failures).not.toContain('ungated_tool_call');
  });

  it('stops the session when a read-kind call completes with no hook', async () => {
    const r = await run('ungated-read');
    expect(r.failures).toContain('ungated_tool_call');
  });
});
