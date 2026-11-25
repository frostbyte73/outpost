import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { FOREIGN_WORKDIR, sameDir, type GateCall } from '../acp/permission.js';

export interface CursorHookPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  mcp_server_name?: string;
}

// `key` names the decision a later hook for the same call replays; `contentKey` is how its request_permission finds it.
export type HookDecisionInput = { deny: string } | { key: string; contentKey?: string; call: GateCall };

// The gate call one Cursor hook stands for; `isEdit` says the ACP call with this id is an edit.
export function hookDecisionInput(
  p: CursorHookPayload, session: { cwd: string; dataDir: string }, isEdit: boolean,
): HookDecisionInput {
  const id = p.tool_use_id;
  if (!id) return { deny: 'Outpost could not tell which call this hook is for, so it was not run.' };
  const at = (path: string) => (isAbsolute(path) ? path : resolve(session.cwd, path));
  const input = (p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const rawName = p.tool_name ?? p.hook_event_name ?? 'unknown';

  if (p.hook_event_name === 'beforeMCPExecution') {
    const server = str(p.mcp_server_name);
    const tool = str(p.tool_name);
    if (!server || !tool) return { deny: 'Outpost could not read which MCP tool this is, so it was not run.' };
    let args: unknown;
    try { args = typeof p.tool_input === 'string' ? JSON.parse(p.tool_input) : p.tool_input ?? {}; } catch {
      return { deny: 'Outpost could not read this MCP call\'s arguments, so it was not run.' };
    }
    const name = `mcp:${server}/${tool}`;
    return { key: `${id}\0mcp`, contentKey: name, call: { tool: name, rawName: tool, input: args } };
  }
  if (p.hook_event_name !== 'preToolUse') return { deny: `Outpost does not allow ${p.hook_event_name ?? 'this hook'} in a gated session.` };

  const filePath = str(input.file_path);
  switch (p.tool_name) {
    case 'Read':
    case 'Write': {
      if (!filePath) return { deny: 'Outpost could not read which file this touches, so it was not run.' };
      const file_path = at(filePath);
      // An edit fires Read then Write under one id and only a deny at Read stops it, so the write is decided there.
      if (p.tool_name === 'Write' || isEdit) {
        if (under(file_path, session.dataDir)) return { deny: 'Outpost does not let a session write its own Cursor data directory.' };
        return { key: `${id}\0edit`, call: { tool: 'file_write', rawName: 'Edit', input: { file_path } } };
      }
      return { key: `${id}\0read`, call: { tool: 'file_read', rawName, input: { file_path } } };
    }
    case 'Delete': {
      if (!filePath) return { deny: 'Outpost could not read which file this deletes, so it was not run.' };
      const file_path = at(filePath);
      if (under(file_path, session.dataDir)) return { deny: 'Outpost does not let a session write its own Cursor data directory.' };
      return { key: `${id}\0delete`, call: { tool: 'file_edit', rawName, input: { file_path } } };
    }
    case 'Grep':
    case 'List':
      return { key: `${id}\0search`, call: { tool: 'file_grep', rawName, input: { path: at(str(input.path) ?? session.cwd) } } };
    case 'Shell': {
      const command = str(input.command);
      if (!command) return { deny: 'Outpost could not read this shell command, so it was not run.' };
      const cwd = str(input.cwd);
      if (cwd && !sameDir(at(cwd), session.cwd)) return { deny: FOREIGN_WORKDIR };
      return { key: `${id}\0shell`, contentKey: `shell:${command}`, call: { tool: 'shell', rawName, input: { command } } };
    }
    case 'WebSearch': {
      const query = str(input.search_term);
      if (!query) return { deny: 'Outpost could not read this search, so it was not run.' };
      return { key: `${id}\0web`, contentKey: `web_search:${query}`, call: { tool: 'web_search', rawName, input: { query } } };
    }
    case 'WebFetch':
    case 'Fetch': {
      const url = str(input.url);
      if (!url) return { deny: 'Outpost could not read which URL this fetches, so it was not run.' };
      return { key: `${id}\0fetch`, call: { tool: 'web_fetch', rawName, input: { url } } };
    }
    default:
      return { deny: `Outpost does not run Cursor's ${rawName} tool in a gated session.` };
  }
}

// `dir` is already a realpath; the target may not exist yet, so resolve its nearest existing ancestor.
function under(path: string, dir: string): boolean {
  const real = realOrAncestor(path);
  return real === dir || real.startsWith(dir + sep);
}

function realOrAncestor(path: string): string {
  try { return realpathSync(path); } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realOrAncestor(parent), basename(path));
  }
}
