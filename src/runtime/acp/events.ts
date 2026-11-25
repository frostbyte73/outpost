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
        input: { file_path, ...(diff ? { old_string: diff.oldText ?? '', new_string: diff.newText ?? '' } : {}) },
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

// The canonical item for a call as it stands now.
export function toolItem(call: AcpToolCall, cfg: AcpAgentConfig): ToolCallItem {
  const mcp = call.kind === 'other' ? mcpToolName(call.title, cfg) : undefined;
  const shown = mcp ? undefined : displayCall(call, cfg);
  const status: ItemStatus = call.status === 'completed' ? 'completed' : call.status === 'failed' ? 'failed' : 'inProgress';
  const text = (call.content ?? []).map((c) => c.content?.type === 'text' ? c.content.text : undefined).filter(Boolean).join('\n');
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

// Canonical events for one session/update, merging tool frames into `calls` as a side effect.
export function mapAcpUpdate(update: AcpSessionUpdate, calls: Map<string, AcpToolCall>, cfg: AcpAgentConfig): CanonicalEvent[] {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const text = (update as { content: { text?: string } }).content?.text;
      if (!text) return [];
      return [{ type: 'content.delta', stream: update.sessionUpdate === 'agent_message_chunk' ? 'assistant_text' : 'reasoning', text }];
    }
    case 'tool_call':
      return [{ type: 'item.started', item: toolItem(mergeToolCall(calls, update as AcpToolCall), cfg) }];
    case 'tool_call_update': {
      const call = mergeToolCall(calls, update as AcpToolCall);
      // Cursor's first frame is a placeholder ("Find", "grep", "Edit File") with rawInput {}.
      // The arguments, and an edit's diff, arrive on a later update — often before the call finishes.
      if (call.status === 'completed' || call.status === 'failed') return [{ type: 'item.completed', item: toolItem(call, cfg) }];
      const u = update as AcpToolCall;
      if (u.title == null && u.rawInput == null && u.locations == null && u.content == null) return [];
      return [{ type: 'item.updated', item: toolItem(call, cfg) }];
    }
    default:
      return [];
  }
}
