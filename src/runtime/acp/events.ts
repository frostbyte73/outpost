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

// The canonical item for a call as it stands now.
export function toolItem(call: AcpToolCall, cfg: AcpAgentConfig): ToolCallItem {
  const mcp = call.kind === 'other' ? mcpToolName(call.title, cfg) : undefined;
  const status: ItemStatus = call.status === 'completed' ? 'completed' : call.status === 'failed' ? 'failed' : 'inProgress';
  const text = (call.content ?? []).map((c) => c.content?.type === 'text' ? c.content.text : undefined).filter(Boolean).join('\n');
  return {
    type: 'tool_call',
    id: call.toolCallId,
    kind: mcp ? 'mcp_tool_call' : KIND[call.kind ?? ''] ?? 'dynamic_tool_call',
    tool: mcp ?? CANONICAL_TOOL[call.kind ?? ''] ?? `native:${call.title ?? call.kind ?? 'unknown'}`,
    rawName: call.title ?? call.kind ?? 'unknown',
    input: call.rawInput ?? {},
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
      return call.status === 'completed' || call.status === 'failed' ? [{ type: 'item.completed', item: toolItem(call, cfg) }] : [];
    }
    default:
      return [];
  }
}
