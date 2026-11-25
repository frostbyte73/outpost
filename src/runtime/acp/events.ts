import type { AcpAgentConfig } from './config.js';
import { mcpToolName, type AcpToolCall } from './permission.js';
import type { CanonicalEvent, ItemStatus, ToolCallItem, ToolKind } from '../types.js';

export type AcpSessionUpdate =
  | { sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk'; content: { type: string; text?: string } }
  | ({ sessionUpdate: 'tool_call' | 'tool_call_update' } & AcpToolCall)
  | { sessionUpdate: string };

const CANONICAL_TOOL: Record<string, string> = {
  execute: 'shell', edit: 'file_edit', delete: 'file_edit', move: 'file_edit',
  read: 'file_read', search: 'file_grep', fetch: 'web_fetch',
};

const KIND: Record<string, ToolKind> = {
  execute: 'command_execution', edit: 'file_change', delete: 'file_change', move: 'file_change',
  read: 'file_read', search: 'file_read', fetch: 'web_fetch',
};

// Folds an update into the call's record; null and absent fields keep what an earlier frame said.
export function mergeToolCall(calls: Map<string, AcpToolCall>, u: AcpToolCall): AcpToolCall {
  const prev = calls.get(u.toolCallId);
  const fields = Object.entries(u).filter(([k, v]) => k !== 'sessionUpdate' && v !== undefined && v !== null);
  const merged = { ...prev, ...Object.fromEntries(fields) } as AcpToolCall;
  calls.set(u.toolCallId, merged);
  return merged;
}

// An ACP diff carries the whole file before and after, but the Edit tile renders old_string/new_string as the
// change, so the lines both sides share at the head and tail are dropped. A new file (empty old side) keeps all.
function changedLines(oldText: string, newText: string): { old_string: string; new_string: string } {
  if (!oldText || oldText === newText) return { old_string: oldText, new_string: newText };
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { old_string: a.slice(head, a.length - tail).join('\n'), new_string: b.slice(head, b.length - tail).join('\n') };
}

// Claude-shaped name and input for the transcript's renderers, read from what the agent sent. Cursor titles
// calls for display ("Edit `/a.ts`", "`ls -la`") and often sends no rawInput, so the input is read off the title.
// A call is renamed only when its primary field is recoverable: an empty Edit or Grep tile is worse than a titled one.
function displayCall(call: AcpToolCall, cfg: AcpAgentConfig): { rawName: string; input: Record<string, unknown> } | undefined {
  const title = call.title ?? '';
  const raw = (call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const location = call.locations?.find((l) => typeof l.path === 'string')?.path;
  const quoted = /`([^`]+)`/.exec(title)?.[1];
  switch (call.kind) {
    case 'execute': {
      const command = str(raw[cfg.shellCommandField]) ?? /^`(.+)`$/s.exec(title)?.[1] ?? str(title);
      return command ? { rawName: 'Bash', input: { command } } : undefined;
    }
    case 'edit': {
      const file_path = location ?? quoted;
      if (!file_path) return undefined;
      const diff = (call.content ?? []).find((c) => c.type === 'diff' && c.path === file_path);
      return {
        rawName: 'Edit',
        input: { file_path, ...(diff ? changedLines(diff.oldText ?? '', diff.newText ?? '') : {}) },
      };
    }
    case 'read': {
      const file_path = location ?? /^Read\s+`?([^`]+?)`?$/.exec(title)?.[1];
      return file_path ? { rawName: 'Read', input: { file_path } } : undefined;
    }
    case 'search': {
      const pattern = str(raw.pattern) ?? str(raw.query) ?? quoted;
      if (!pattern) return undefined;
      const path = str(raw.path) ?? location;
      // Cursor titles its glob tool "Find" and its content search "grep"; both arrive as kind search.
      return { rawName: /^Find\b/.test(title) ? 'Glob' : 'Grep', input: { pattern, ...(path ? { path } : {}) } };
    }
    case 'fetch': {
      const url = str(raw.url);
      return url ? { rawName: 'WebFetch', input: { url } } : undefined;
    }
    default:
      return undefined;
  }
}

// Cursor prints this when its own shell allowlist is empty. Outpost clears that list so the hook
// gates every command; the command still runs, and this notice is not its output.
const SHELL_ALLOWLIST_NOTE = 'Shell allowlist is empty';

function contentText(call: AcpToolCall): string {
  return (call.content ?? [])
    .map((c) => c.content?.type === 'text' ? c.content.text : undefined)
    .filter((t): t is string => !!t)
    .join('\n')
    .split('\n')
    .filter((line) => line.trim() !== SHELL_ALLOWLIST_NOTE)
    .join('\n')
    .trim();
}

// The canonical item for a call as it stands now.
export function toolItem(call: AcpToolCall, cfg: AcpAgentConfig): ToolCallItem {
  const mcp = call.kind === 'other' ? mcpToolName(call.title, cfg) : undefined;
  const shown = mcp ? undefined : displayCall(call, cfg);
  const status: ItemStatus = call.status === 'completed' ? 'completed' : call.status === 'failed' ? 'failed' : 'inProgress';
  const text = contentText(call);
  return {
    type: 'tool_call',
    id: call.toolCallId,
    kind: mcp ? 'mcp_tool_call' : KIND[call.kind ?? ''] ?? 'dynamic_tool_call',
    tool: mcp ?? (shown?.rawName === 'Glob' ? 'file_glob' : CANONICAL_TOOL[call.kind ?? ''] ?? `native:${call.title ?? call.kind ?? 'unknown'}`),
    rawName: shown?.rawName ?? call.title ?? call.kind ?? 'unknown',
    input: shown ? { ...(call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {}), ...shown.input } : call.rawInput ?? {},
    status,
    ...(text ? { resultText: text } : {}),
  };
}

// Kinds whose tile needs the call's arguments to say anything; delete and move show their title as-is.
const ARGUMENT_KINDS: ReadonlySet<string> = new Set(['execute', 'edit', 'read', 'search', 'fetch']);

// Cursor's first frame names a search, read or edit before its arguments arrive, and an edit's diff can come later
// still. A tile painted from that frame is empty, so the call waits for the frame that fills it in.
function awaitingArguments(call: AcpToolCall, cfg: AcpAgentConfig): boolean {
  if (call.status === 'completed' || call.status === 'failed') return false;
  if (!ARGUMENT_KINDS.has(call.kind ?? '')) return false;
  if (!displayCall(call, cfg)) return true;
  return call.kind === 'edit' && !(call.content ?? []).some((c) => c.type === 'diff');
}

// Canonical events for one session/update, merging tool frames into `calls` as a side effect.
export function mapAcpUpdate(update: AcpSessionUpdate, calls: Map<string, AcpToolCall>, cfg: AcpAgentConfig): CanonicalEvent[] {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const text = (update as { content: { text?: string } }).content?.text;
      if (!text) return [];
      return [{ type: 'content.delta', stream: update.sessionUpdate === 'agent_message_chunk' ? 'assistant_text' : 'reasoning', text }];
    }
    case 'tool_call': {
      const call = mergeToolCall(calls, update as AcpToolCall);
      if (awaitingArguments(call, cfg)) return [];
      return [{ type: 'item.started', item: toolItem(call, cfg) }];
    }
    case 'tool_call_update': {
      const before = calls.get((update as AcpToolCall).toolCallId);
      const wasAwaiting = !before || awaitingArguments(before, cfg);
      const call = mergeToolCall(calls, update as AcpToolCall);
      if (call.status === 'completed' || call.status === 'failed') return [{ type: 'item.completed', item: toolItem(call, cfg) }];
      const u = update as AcpToolCall;
      if (u.title == null && u.rawInput == null && u.locations == null && u.content == null) return [];
      if (awaitingArguments(call, cfg)) return [];
      return [{ type: wasAwaiting ? 'item.started' : 'item.updated', item: toolItem(call, cfg) }];
    }
    default:
      return [];
  }
}
