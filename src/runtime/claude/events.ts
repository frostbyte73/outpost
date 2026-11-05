import { canonicalToolName, toolKind } from '../tools.js';
import type { CanonicalEvent, SubagentRef, ToolCallItem, UsageUpdate } from '../types.js';

interface Block {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface Frame {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  mcp_servers?: { name: string; status: string }[];
  task_id?: string;
  status?: string;
  summary?: string;
  isSidechain?: boolean;
  parent_tool_use_id?: string | null;
  agent_id?: string;
  modelUsage?: Record<string, { contextWindow?: number }>;
  message?: { id?: string; model?: string; content?: Block[] | string; usage?: RawUsage; stop_reason?: string | null };
  event?: StreamEvent;
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface StreamEvent {
  type?: string;
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string | null };
  usage?: RawUsage;
  message?: { usage?: RawUsage };
}

const DELTA_STREAMS: Record<string, { stream: 'assistant_text' | 'reasoning' | 'tool_input'; field: 'text' | 'thinking' | 'partial_json' }> = {
  text_delta: { stream: 'assistant_text', field: 'text' },
  thinking_delta: { stream: 'reasoning', field: 'thinking' },
  input_json_delta: { stream: 'tool_input', field: 'partial_json' },
};

// A `tool_use` stop means the model is waiting on tool results, not that the turn is over.
const isTerminalStop = (reason: string | null | undefined): reason is string => !!reason && reason !== 'tool_use';

// The text a tool_result carries, whether Claude sent it as a string or as text blocks.
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[]).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

// Maps one session's Claude Code stream-json to canonical events, pairing each tool_result with its call.
export class StreamJsonMapper {
  private readonly inFlight = new Map<string, ToolCallItem>();
  private seq = 0;

  map(raw: unknown): CanonicalEvent[] {
    if (typeof raw !== 'object' || raw === null) return [];
    const f = raw as Frame;
    const events = this.mapFrame(f);
    const subagent = subagentOf(f);
    return subagent ? events.map((e) => ({ ...e, subagent })) : events;
  }

  private mapFrame(f: Frame): CanonicalEvent[] {
    switch (f.type) {
      case 'system': return this.system(f);
      case 'stream_event': return this.streamEvent(f.event ?? {});
      case 'assistant': return this.assistant(f);
      case 'user': return this.user(f);
      case 'result': return this.result(f);
      default: return [];
    }
  }

  private system(f: Frame): CanonicalEvent[] {
    if (f.subtype === 'init' && typeof f.session_id === 'string') {
      return [{
        type: 'session.started',
        sessionId: f.session_id,
        ...(f.model ? { model: f.model } : {}),
        mcpServers: Array.isArray(f.mcp_servers) ? f.mcp_servers : [],
      }];
    }
    if (f.subtype === 'task_notification' && typeof f.task_id === 'string') {
      return [{
        type: 'task.notification',
        taskId: f.task_id,
        ...(f.status ? { status: f.status } : {}),
        ...(f.summary ? { summary: f.summary } : {}),
      }];
    }
    return [];
  }

  private streamEvent(ev: StreamEvent): CanonicalEvent[] {
    if (ev.type === 'message_start') {
      const out = ev.message?.usage?.output_tokens;
      return [
        { type: 'turn.started' },
        ...(typeof out === 'number' ? [usage({ streamingOutputTokens: out })] : []),
      ];
    }
    if (ev.type === 'content_block_delta') {
      const spec = ev.delta?.type ? DELTA_STREAMS[ev.delta.type] : undefined;
      const text = spec ? ev.delta?.[spec.field] : undefined;
      return spec && typeof text === 'string' ? [{ type: 'content.delta', stream: spec.stream, text }] : [];
    }
    if (ev.type === 'message_delta') {
      const out = ev.usage?.output_tokens;
      const stop = ev.delta?.stop_reason;
      return [
        ...(typeof out === 'number' ? [usage({ streamingOutputTokens: out })] : []),
        ...(isTerminalStop(stop) ? [{ type: 'turn.completed' as const, state: 'completed' as const, stopReason: stop }] : []),
      ];
    }
    return [];
  }

  private assistant(f: Frame): CanonicalEvent[] {
    const m = f.message;
    if (!m || !Array.isArray(m.content)) return [];
    const events: CanonicalEvent[] = [];
    for (const b of m.content) {
      if (b.type === 'text' && typeof b.text === 'string') {
        events.push({
          type: 'item.completed',
          item: { type: 'assistant_message', id: `a${this.seq++}`, ...(m.id ? { messageId: m.id } : {}), text: b.text },
        });
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        const tool = canonicalToolName(b.name);
        const item: ToolCallItem = {
          type: 'tool_call',
          id: b.id ?? `t${this.seq++}`,
          ...(m.id ? { messageId: m.id } : {}),
          kind: toolKind(tool),
          tool,
          rawName: b.name,
          input: b.input,
          status: 'inProgress',
        };
        if (b.id) this.inFlight.set(b.id, item);
        events.push({ type: 'item.started', item });
      }
    }
    // A thinking-only delivery carries nothing a consumer renders.
    if (events.length === 0) return [];
    if (m.usage) {
      events.push(usage({
        ...(m.model ? { model: m.model } : {}),
        response: {
          inputTokens: m.usage.input_tokens ?? 0,
          outputTokens: m.usage.output_tokens ?? 0,
          cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: m.usage.cache_creation_input_tokens ?? 0,
        },
      }));
    }
    if (isTerminalStop(m.stop_reason)) events.push({ type: 'turn.completed', state: 'completed', stopReason: m.stop_reason });
    return events;
  }

  private user(f: Frame): CanonicalEvent[] {
    const content = f.message?.content;
    if (!Array.isArray(content)) return [];
    const events: CanonicalEvent[] = [];
    for (const b of content) {
      if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      const started = this.inFlight.get(b.tool_use_id);
      this.inFlight.delete(b.tool_use_id);
      const base: ToolCallItem = started ?? {
        type: 'tool_call', id: b.tool_use_id, kind: 'dynamic_tool_call', tool: 'native:unknown', rawName: '', input: null, status: 'inProgress',
      };
      events.push({
        type: 'item.completed',
        item: { ...base, status: b.is_error ? 'failed' : 'completed', resultText: toolResultText(b.content) },
      });
    }
    return events;
  }

  private result(f: Frame): CanonicalEvent[] {
    if (!f.modelUsage || typeof f.modelUsage !== 'object') return [];
    const contextWindows: Record<string, number> = {};
    for (const [model, u] of Object.entries(f.modelUsage)) {
      if (typeof u?.contextWindow === 'number' && u.contextWindow > 0) contextWindows[model] = u.contextWindow;
    }
    return Object.keys(contextWindows).length ? [usage({ contextWindows })] : [];
  }
}

function usage(u: UsageUpdate): CanonicalEvent {
  return { type: 'usage.updated', usage: u };
}

function subagentOf(f: Frame): SubagentRef | undefined {
  if (!f.isSidechain && !f.parent_tool_use_id && !f.agent_id) return undefined;
  return {
    ...(f.agent_id ? { agentId: f.agent_id } : {}),
    ...(f.parent_tool_use_id ? { parentToolCallId: f.parent_tool_use_id } : {}),
  };
}
