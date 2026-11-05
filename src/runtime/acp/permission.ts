import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { AcpAgentConfig } from './config.js';

export interface AcpToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: { path: string }[];
  content?: { type: string; path?: string; content?: { type: string; text?: string } }[];
}

export interface AcpPermissionOption {
  optionId: string;
  kind: string;
}

export interface GateCall {
  tool: string;
  rawName: string;
  input: unknown;
}

export type PermissionReply = { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } };

const FOREIGN_WORKDIR = 'Outpost gates shell commands against the session directory only. Run this without a different '
  + 'working directory, using paths relative to the session directory or absolute paths.';
const DIR_KEY = /cwd|dir/i;
const NO_PATHS ='Outpost could not read which files this edit touches, so it was not applied.';

// The gate calls one permission request stands for, or why its full input can't be read.
export function gateCallsFor(call: AcpToolCall, cwd: string, cfg: AcpAgentConfig): GateCall[] | { deny: string } {
  const rawName = call.title ?? call.kind ?? 'unknown';
  const raw = (call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {}) as Record<string, unknown>;
  const at = (p: string) => (isAbsolute(p) ? p : resolve(cwd, p));
  const locations = (call.locations ?? []).map((l) => l.path).filter((p) => typeof p === 'string').map(at);
  switch (call.kind) {
    case 'execute': {
      const command = raw[cfg.shellCommandField];
      if (typeof command !== 'string' || !command) return { deny: 'Outpost could not read this shell command, so it was not run.' };
      // Agents name the working directory differently (cwd, directory, dir_path, workdir), so match by shape.
      for (const [key, dir] of Object.entries(raw)) {
        if (DIR_KEY.test(key) && typeof dir === 'string' && dir && !sameDir(at(dir), cwd)) return { deny: FOREIGN_WORKDIR };
      }
      return [{ tool: 'shell', rawName, input: { command } }];
    }
    case 'edit':
    case 'delete':
    case 'move': {
      const diffPaths = (call.content ?? []).filter((c) => c.type === 'diff' && typeof c.path === 'string').map((c) => at(c.path!));
      const paths = [...new Set([...locations, ...diffPaths])];
      if (paths.length === 0) return { deny: NO_PATHS };
      if (call.kind === 'move' && paths.length < 2) return { deny: 'Outpost could not read both ends of this move, so it was not run.' };
      return paths.map((file_path) => ({ tool: 'file_edit', rawName, input: { file_path } }));
    }
    case 'read':
      if (locations.length === 0) return { deny: 'Outpost could not read which file this reads, so it was not run.' };
      return locations.map((file_path) => ({ tool: 'file_read', rawName, input: { file_path } }));
    case 'search':
      if (locations.length === 0) return { deny: 'Outpost could not read where this searches, so it was not run.' };
      return locations.map((path) => ({ tool: 'file_grep', rawName, input: { path } }));
    case 'fetch':
      if (typeof raw.url !== 'string' || !raw.url) return { deny: 'Outpost could not read which URL this fetches, so it was not run.' };
      return [{ tool: 'web_fetch', rawName, input: { url: raw.url } }];
    case 'other': {
      const mcp = mcpToolName(call.title, cfg);
      return [{ tool: mcp ?? `native:${rawName}`, rawName, input: call.rawInput ?? {} }];
    }
    default:
      return { deny: `Outpost does not run ${call.kind ?? 'unclassified'} tool calls.` };
  }
}

// `mcp:<server>/<tool>` when the agent's title for a call names an MCP tool.
export function mcpToolName(title: string | undefined, cfg: AcpAgentConfig): string | undefined {
  if (!title || !cfg.mcpTitlePattern) return undefined;
  const g = new RegExp(cfg.mcpTitlePattern).exec(title)?.groups;
  return g?.server && g.tool ? `mcp:${g.server}/${g.tool}` : undefined;
}

// Never `allow_always`: the agent would stop asking, and every later call would skip the gate.
export function permissionReply(options: AcpPermissionOption[], allow: boolean): PermissionReply {
  const pick = (kind: string) => options.find((o) => o.kind === kind)?.optionId;
  const chosen = (allow ? pick('allow_once') : undefined) ?? pick('reject_once');
  return chosen ? { outcome: { outcome: 'selected', optionId: chosen } } : { outcome: { outcome: 'cancelled' } };
}

function sameDir(a: string, b: string): boolean {
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return real(a) === real(b);
}
