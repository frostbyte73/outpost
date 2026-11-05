import { codexCanonicalTool } from './tools.js';
import type { CanonicalItem, ItemStatus, ToolKind } from '../types.js';

// The slice of Codex's v2 ThreadItem union Outpost reads; the payload is flat, tagged by `type`.
export type CodexItem =
  | { type: 'userMessage'; id: string; content: { type: string; text?: string }[] }
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'commandExecution'; id: string; command: string; status: CodexStatus; source?: string; aggregatedOutput?: string | null; exitCode?: number | null }
  | { type: 'fileChange'; id: string; changes: { path: string; kind: unknown; diff: string }[]; status: CodexStatus }
  | { type: 'mcpToolCall'; id: string; server: string; tool: string; arguments: unknown; status: CodexStatus; result?: unknown; error?: { message?: string } | null }
  | { type: 'webSearch'; id: string; query?: string }
  | { type: string; id: string };

export type CodexStatus = 'inProgress' | 'completed' | 'failed' | 'declined';

export type CodexToolItem = Extract<CodexItem, { type: 'commandExecution' | 'fileChange' | 'mcpToolCall' }>;

export function isToolItem(item: CodexItem): item is CodexToolItem {
  return item.type === 'commandExecution' || item.type === 'fileChange' || item.type === 'mcpToolCall';
}

export function mcpRawName(item: { server: string; tool: string }): string {
  return `mcp__${item.server}__${item.tool}`;
}

// A Codex item in Outpost's canonical shape; undefined for kinds the transcript doesn't show.
export function toCanonicalItem(item: CodexItem): CanonicalItem | undefined {
  switch (item.type) {
    case 'userMessage': {
      const { content } = item as Extract<CodexItem, { type: 'userMessage' }>;
      return { type: 'user_message', id: item.id, text: content.map((c) => c.text ?? '').join('') };
    }
    case 'agentMessage':
      return { type: 'assistant_message', id: item.id, text: (item as Extract<CodexItem, { type: 'agentMessage' }>).text };
    case 'commandExecution': {
      const c = item as Extract<CodexItem, { type: 'commandExecution' }>;
      return tool(c.id, 'command_execution', 'Bash', { command: c.command }, c.status, c.aggregatedOutput ?? undefined);
    }
    case 'fileChange': {
      const f = item as Extract<CodexItem, { type: 'fileChange' }>;
      return tool(f.id, 'file_change', 'apply_patch', { changes: f.changes }, f.status, f.changes.map((c) => c.diff).join('\n'));
    }
    case 'mcpToolCall': {
      const m = item as Extract<CodexItem, { type: 'mcpToolCall' }>;
      const result = m.error?.message ?? (m.result === undefined ? undefined : JSON.stringify(m.result));
      return tool(m.id, 'mcp_tool_call', mcpRawName(m), m.arguments, m.status, result);
    }
    case 'webSearch':
      return tool(item.id, 'web_search', 'web_search', { query: (item as { query?: string }).query }, 'completed');
    default:
      return undefined;
  }
}

function tool(id: string, kind: ToolKind, rawName: string, input: unknown, status: ItemStatus, resultText?: string): CanonicalItem {
  return {
    type: 'tool_call', id, kind, tool: codexCanonicalTool(rawName), rawName, input, status,
    ...(resultText !== undefined ? { resultText } : {}),
  };
}
