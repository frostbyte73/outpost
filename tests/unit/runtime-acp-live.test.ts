import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAcpAgents } from '../../src/runtime/acp/config.js';
import { AcpRuntime } from '../../src/runtime/acp/runtime.js';
import { findOnPath } from '../../src/runtime/bin.js';
import { JsonlTranscripts } from '../../src/runtime/jsonl-transcripts.js';
import type { CanonicalEvent, GateRequest, RuntimeHost, RuntimeSession } from '../../src/runtime/types.js';

const configPath = process.env.OUTPOST_ACP_AGENTS ?? join(homedir(), '.outpost', 'acp-agents.json');
const agent = process.env.OUTPOST_ACP_LIVE && existsSync(configPath)
  ? loadAcpAgents(configPath).find((a) => a.id === process.env.OUTPOST_ACP_LIVE)
  : undefined;
const bin = agent ? findOnPath(agent.command) : null;

// Against a real ACP agent (OUTPOST_ACP_LIVE=<agent id>): read, edit and MCP turns all run through the gate.
describe.skipIf(!agent || !bin)('ACP runtime (live)', () => {
  const gated: GateRequest[] = [];
  const failures: string[] = [];
  let session: RuntimeSession | undefined;
  let dir = '';
  let runtime: AcpRuntime;

  const host: RuntimeHost = {
    gateToolCall: async (r) => { gated.push(r); return { allow: true }; },
    onToolFailed: () => {}, onToolCompleted: () => {}, onTurnEnded: () => {}, onUsage: () => {},
    onTurnFailed: (_id, code) => { failures.push(code); },
  };

  let mcp: Server;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'outpost-acp-live-'));
    writeFileSync(join(dir, 'README.md'), 'Lighthouse keepers log every ship.\n');
    mcp = createServer(answerMcp);
    await new Promise<void>((r) => mcp.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`;
    runtime = new AcpRuntime({
      agent: agent!, bin, host: () => host, mcpServers: () => new Map([['probe', { type: 'http', url }]]),
      transcripts: new JsonlTranscripts(join(dir, '.transcripts')),
      nativeIds: { read: () => null, write: () => {} },
      actionBody: () => undefined,
    });
  });

  function runTurn(text: string): Promise<CanonicalEvent[]> {
    const events: CanonicalEvent[] = [];
    return new Promise((resolve, reject) => {
      session = runtime.start({ sessionId: `live-${Date.now()}`, mode: 'new', cwd: dir, env: {}, isAction: true }, {
        onEvent: (e) => { events.push(e); if (e.type === 'turn.completed') resolve(events); },
        onError: () => {},
        onExit: (code) => reject(new Error(`agent exited ${code} before the turn ended`)),
      });
      session.sendTurn({ text });
    });
  }

  afterEach(async () => {
    await session?.kill();
    gated.length = 0;
    failures.length = 0;
  });

  afterAll(() => new Promise<void>((r) => mcp.close(() => r())));

  it('runs a read turn without tripping the tripwire', async () => {
    const events = await runTurn('Read README.md in this directory and reply with only its first word.');
    expect(failures).not.toContain('ungated_tool_call');
    const text = events.flatMap((e) => (e.type === 'item.completed' && e.item.type === 'assistant_message' ? [e.item.text] : []));
    expect(text.join(' ')).toMatch(/Lighthouse/);
  }, 180_000);

  it('routes a file edit through the gate', async () => {
    await runTurn('Create a file named out.txt in this directory containing exactly: hi');
    expect(failures).not.toContain('ungated_tool_call');
    expect(gated.some((r) => r.tool === 'file_edit' && String((r.input as { file_path?: string }).file_path).endsWith('out.txt'))).toBe(true);
    expect(existsSync(join(dir, 'out.txt'))).toBe(true);
  }, 180_000);

  // A wrong mcpTitlePattern turns every mcp__outpost__* call into a native: tool no rule grants.
  it('names an MCP call by the agent mcpTitlePattern', async () => {
    await runTurn('Call the `ping` tool from the `probe` MCP server once, then reply with what it returned.');
    expect(failures).not.toContain('ungated_tool_call');
    expect(gated.map((r) => r.tool)).toContain('mcp:probe/ping');
  }, 180_000);
});

// A one-tool MCP server over streamable HTTP, answering with plain JSON.
function answerMcp(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
  let body = '';
  req.on('data', (d: Buffer) => { body += d.toString(); });
  req.on('end', () => {
    const msg = JSON.parse(body) as { id?: number | string; method: string };
    if (msg.id === undefined) { res.statusCode = 202; res.end(); return; }
    const result = msg.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } }
      : msg.method === 'tools/list'
        ? { tools: [{ name: 'ping', description: 'Replies pong', inputSchema: { type: 'object', properties: {} } }] }
        : msg.method === 'tools/call'
          ? { content: [{ type: 'text', text: 'pong' }] }
          : undefined;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result === undefined
      ? { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no ${msg.method}` } }
      : { jsonrpc: '2.0', id: msg.id, result }));
  });
}
