import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpRuntime } from '../../src/runtime/acp/runtime.js';
import { JsonlTranscripts } from '../../src/runtime/jsonl-transcripts.js';
import type { GateRequest, RuntimeHost } from '../../src/runtime/types.js';

const AGENT = fileURLToPath(new URL('./helpers/fake-acp-agent.mjs', import.meta.url));

interface Run { gated: GateRequest[]; released: unknown[]; failures: string[]; stderr: string; exitCode: number | null | undefined }

function run(script: 'gated' | 'partial' | 'ungated', allow: (r: GateRequest) => boolean = () => true): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'outpost-acp-'));
  const out: Run = { gated: [], released: [], failures: [], stderr: '', exitCode: undefined };
  const host: RuntimeHost = {
    gateToolCall: async (r) => { out.gated.push(r); return allow(r) ? { allow: true } : { allow: false, reason: 'test deny' }; },
    onToolFailed: (r) => { out.released.push(r.input); }, onToolCompleted: () => {}, onUsage: () => {},
    onTurnEnded: () => {}, onTurnFailed: (_id, code) => { out.failures.push(code); },
  };
  const runtime = new AcpRuntime({
    agent: { id: 'fake', command: process.execPath, args: [AGENT], env: {}, shellCommandField: 'command' },
    bin: process.execPath,
    host: () => host,
    mcpServers: () => new Map(),
    transcripts: new JsonlTranscripts(join(dir, 'transcripts')),
    nativeIds: { read: () => null, write: () => {} },
    actionBody: () => undefined,
  });
  return new Promise((resolve) => {
    const session = runtime.start({ sessionId: `s-${script}`, mode: 'new', cwd: dir, env: { FAKE_ACP_SCRIPT: script }, isAction: true }, {
      onEvent: (e) => {
        if (e.type === 'turn.completed') void session.kill().then(() => resolve(out));
      },
      onError: (m) => { out.stderr += m; },
      onExit: (code) => { out.exitCode = code; resolve(out); },
    });
    session.sendTurn({ text: 'go' });
  });
}

// The tripwire is the only thing between a misconfigured agent and every write it makes running ungated.
describe('ACP permission tripwire', () => {
  it('lets a call the gate allowed run, answering allow_once, even when the agent repeats its final update', async () => {
    const r = await run('gated');
    expect(r.gated.map((g) => g.tool)).toEqual(['file_edit']);
    expect((r.gated[0]!.input as { file_path: string }).file_path).toMatch(/\/a\.txt$/);
    expect(r.stderr).toContain('permission:{"outcome":{"outcome":"selected","optionId":"once"}}');
    expect(r.failures).not.toContain('ungated_tool_call');
  });

  it('gives back the pin of a file already allowed when a later file in the same request is denied', async () => {
    const r = await run('partial', (g) => !String((g.input as { file_path: string }).file_path).endsWith('b.txt'));
    expect(r.stderr).toContain('permission:{"outcome":{"outcome":"selected","optionId":"no"}}');
    expect(r.released).toHaveLength(1);
    expect((r.released[0] as { file_path: string }).file_path).toMatch(/\/a\.txt$/);
  });

  it('stops the session when a call runs without asking', async () => {
    const r = await run('ungated');
    expect(r.failures).toContain('ungated_tool_call');
    expect(r.exitCode).toBe(1);
  });
});
