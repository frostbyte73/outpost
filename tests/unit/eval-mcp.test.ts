import { describe, it, expect } from 'vitest';
import { handleEvalMcp, replayServerNames } from '../../src/eval/eval-mcp.js';
import { EvalSessions, type EvalSession } from '../../src/eval/eval-sessions.js';
import { readInputKey } from '../../src/permissions/read-recording.js';

function setup() {
  const sessions = new EvalSessions();
  const s: EvalSession = {
    sessionId: 'sid', evalId: 'e', action: 'read.investigate', scratchDir: '/tmp', reads: new Map(), misses: 0, captured: [],
  };
  const tool = 'mcp__claude_ai_Linear__get_issue';
  s.reads.set(readInputKey(tool, { id: 'CS-1' }), { tool, inputKey: readInputKey(tool, { id: 'CS-1' }), responseRef: 'issue' });
  sessions.register(s);
  const blobs: Record<string, string> = { issue: JSON.stringify([{ type: 'text', text: 'CS-1: broken audio' }]) };
  const deps = { sessions, blob: (r: string) => blobs[r] };
  const rpc = (path: string, method: string, params?: unknown) =>
    handleEvalMcp(path, JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), deps)
      .then((r) => ({ status: r.status, body: JSON.parse(r.body || 'null') as { result?: { content?: Array<{ text: string }>; isError?: boolean; tools?: Array<{ name: string }> } } }));
  return { s, rpc };
}

describe('eval MCP surfaces', () => {
  it('captures a write draft and says stop', async () => {
    const { s, rpc } = setup();
    const r = await rpc('/mcp/eval/sid', 'tools/call', { name: 'submit_write_draft', arguments: { jobId: 'j', stepId: 's', summary: 'x', calls: [{ bash: 'gh pr comment 1' }] } });
    expect(r.body.result?.content?.[0]?.text).toMatch(/captured/i);
    expect(s.captured).toEqual([{ tool: 'submit_write_draft', args: expect.objectContaining({ summary: 'x' }) }]);
  });

  it('refuses tools that create work', async () => {
    const { s, rpc } = setup();
    const r = await rpc('/mcp/eval/sid', 'tools/call', { name: 'create_job', arguments: { source: 'x', title: 'y' } });
    expect(r.body.result?.isError).toBe(true);
    expect(s.captured).toEqual([]);
  });

  it('lists only the recorded tools of a replay server and serves a hit', async () => {
    const { rpc } = setup();
    const list = await rpc('/mcp/replay/sid/claude_ai_Linear', 'tools/list');
    expect(list.body.result?.tools?.map((t) => t.name)).toEqual(['get_issue']);
    const hit = await rpc('/mcp/replay/sid/claude_ai_Linear', 'tools/call', { name: 'get_issue', arguments: { id: 'CS-1' } });
    expect(hit.body.result?.content?.[0]?.text).toBe('CS-1: broken audio');
  });

  it('counts a replay miss', async () => {
    const { s, rpc } = setup();
    const r = await rpc('/mcp/replay/sid/claude_ai_Linear', 'tools/call', { name: 'get_issue', arguments: { id: 'CS-2' } });
    expect(r.body.result?.isError).toBe(true);
    expect(s.misses).toBe(1);
  });

  it('404s an unknown session', async () => {
    const { rpc } = setup();
    expect((await rpc('/mcp/eval/nope', 'tools/list')).status).toBe(404);
  });

  it('names one replay server per recorded MCP server', () => {
    const { s } = setup();
    expect(replayServerNames(s)).toEqual(['claude_ai_Linear']);
  });
});
