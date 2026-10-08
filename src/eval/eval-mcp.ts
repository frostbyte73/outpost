import { handleMcpRequest, OUTPOST_MCP_TOOLS, type McpDispatch, type McpResponse, type McpTool } from '../mcp-server.js';
import { readInputKey } from '../permissions/read-recording.js';
import type { EvalSession, EvalSessions } from './eval-sessions.js';

const CAPTURED = [
  'submit_write_draft', 'submit_step_progress', 'submit_step_output', 'submit_step_failed', 'submit_plan', 'submit_continue',
];
const REFUSED = ['create_job', 'submit_action_proposal', 'submit_schedule_proposal'];

const CAPTURED_REPLY = 'Captured for evaluation — this session is a replay and nothing was submitted. Stop your turn now.';

// Every submit lands in the eval record; nothing reaches the engine, so no job state moves and no pin exists.
export function evalOutpostDispatch(s: EvalSession): McpDispatch {
  const dispatch: McpDispatch = {
    submit_journal: async () => ({ ok: true }),
  };
  for (const name of CAPTURED) {
    dispatch[name] = async (args) => {
      s.captured.push({ tool: name, args });
      return CAPTURED_REPLY;
    };
  }
  for (const name of REFUSED) {
    dispatch[name] = async () => { throw new Error(`${name} is refused in an eval replay`); };
  }
  return dispatch;
}

function serverOf(tool: string): string | undefined {
  const m = tool.match(/^mcp__(.+?)__(.+)$/);
  return m?.[1];
}

export function replayServerNames(s: EvalSession): string[] {
  const names = new Set<string>();
  for (const r of s.reads.values()) {
    const server = serverOf(r.tool);
    if (server && server !== 'outpost') names.add(server);
  }
  return [...names];
}

function recordedText(raw: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return raw; }
  if (typeof parsed === 'string') return parsed;
  if (Array.isArray(parsed) && parsed.every((c) => c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string')) {
    return parsed.map((c) => (c as { text: string }).text).join('\n');
  }
  return JSON.stringify(parsed);
}

function replayServer(s: EvalSession, server: string, blob: (ref: string) => string | undefined): { tools: McpTool[]; dispatch: McpDispatch } {
  const prefix = `mcp__${server}__`;
  const locals = new Set([...s.reads.values()].filter((r) => r.tool.startsWith(prefix)).map((r) => r.tool.slice(prefix.length)));
  const tools: McpTool[] = [...locals].map((name) => ({
    name,
    description: `Replayed ${server} tool — only calls made in the original run return data.`,
    inputSchema: { type: 'object', additionalProperties: true },
  }));
  const dispatch: McpDispatch = {};
  for (const name of locals) {
    dispatch[name] = async (args) => {
      const read = s.reads.get(readInputKey(`${prefix}${name}`, args));
      const raw = read ? blob(read.responseRef) : undefined;
      if (raw === undefined) {
        s.misses += 1;
        throw new Error('Not available in replay: this exact call was not recorded. Work from what you already have.');
      }
      return recordedText(raw);
    };
  }
  return { tools, dispatch };
}

export async function handleEvalMcp(
  path: string,
  body: string,
  deps: { sessions: EvalSessions; blob: (ref: string) => string | undefined },
): Promise<McpResponse> {
  const notFound: McpResponse = { status: 404, headers: {}, body: '' };
  const outpost = path.match(/^\/mcp\/eval\/([^/]+)$/);
  if (outpost) {
    const s = deps.sessions.get(decodeURIComponent(outpost[1]!));
    return s ? handleMcpRequest(body, OUTPOST_MCP_TOOLS, evalOutpostDispatch(s)) : notFound;
  }
  const replay = path.match(/^\/mcp\/replay\/([^/]+)\/([^/]+)$/);
  if (!replay) return notFound;
  const s = deps.sessions.get(decodeURIComponent(replay[1]!));
  if (!s) return notFound;
  const server = decodeURIComponent(replay[2]!);
  const { tools, dispatch } = replayServer(s, server, deps.blob);
  return handleMcpRequest(body, tools, dispatch, server);
}
