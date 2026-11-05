import { readFileSync } from 'node:fs';
import { LineParser } from '../../session/stream-json.js';
import { splitBashBlocks } from '../../session/shell-exec.js';
import { canonicalToolName, toolKind } from '../tools.js';
import { toolResultText } from './events.js';
import type { CanonicalItem, SubagentCompletion, ToolCallItem } from '../types.js';

// Tools whose result is kept in history (instead of dropped) because the PWA renders the pair specially.
const PAIRED_TOOLS = new Set(['task_create', 'task_update', 'task_list', 'task_get', 'ask_user']);

// Skip Claude Code's synthetic "user" messages (command echoes, reminders, task-notifications, skill loadouts).
export function isSystemInjection(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<local-command-') ||
    t.startsWith('<command-') ||
    t.startsWith('<system-reminder>') ||
    t.startsWith('<task-notification>') ||
    t.startsWith('Base directory for this skill:') ||
    t.startsWith('Caveat: ');
}

// Extract <command-args> from a slash-command invocation so the transcript shows what the human typed.
// Returns null if not a slash-command invocation.
function rewriteSlashCommandInvocation(text: string): string | null {
  if (!text.trimStart().startsWith('<command-message>')) return null;
  const m = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
  if (!m) return null;
  const args = m[1]!.trim();
  return args.length > 0 ? args : null;
}

interface RawContentBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

export interface RawSessionRecord {
  type?: string;
  toolUseResult?: unknown;
  message?: {
    id?: string;
    role?: string;
    content?: string | RawContentBlock[];
  };
  attachment?: { type?: string; prompt?: unknown; commandMode?: string };
}

// A message sent mid-turn is stored as a `queued_command` attachment, never as a `user` record
function absorbedUserRecord(o: RawSessionRecord): RawSessionRecord | null {
  const a = o.attachment;
  if (o.type !== 'attachment' || a?.type !== 'queued_command' || a.commandMode !== 'prompt') return null;
  if (typeof a.prompt !== 'string' && !Array.isArray(a.prompt)) return null;
  return { type: 'user', message: { role: 'user', content: a.prompt as string | RawContentBlock[] } };
}

// Turns one session JSONL into canonical items, completing each tool call from its tool_result line.
export class TranscriptItemParser {
  readonly items: CanonicalItem[] = [];
  private readonly calls = new Map<string, ToolCallItem>();
  private seq = 0;

  push(obj: unknown): void {
    const raw = obj as RawSessionRecord;
    const o = absorbedUserRecord(raw) ?? raw;
    if (o.type !== 'user' && o.type !== 'assistant') return;
    const content = o.message?.content;
    const msgId = o.type === 'assistant' ? o.message?.id : undefined;
    if (typeof content === 'string') {
      this.text(o.type, content, msgId);
      return;
    }
    if (!Array.isArray(content)) return;
    const before = this.items.length;
    for (const b of content) {
      if (b.type === 'text' && typeof b.text === 'string') this.text(o.type, b.text, msgId);
      else if (b.type === 'tool_use' && o.type === 'assistant') this.toolUse(b, msgId);
      else if (b.type === 'tool_result' && o.type === 'user') this.toolResult(b, raw.toolUseResult);
    }
    // A top-level image block in a user record is one the user attached (a Read of an image
    // nests inside its tool_result instead).
    const images = o.type === 'user' ? content.filter((b) => b.type === 'image').length : 0;
    if (images > 0) {
      const first = this.items.slice(before).find((i) => i.type === 'user_message');
      if (first && first.type === 'user_message') first.images = images;
      else this.items.splice(before, 0, { type: 'user_message', id: this.nextId('u'), text: '', images });
    }
  }

  private text(role: 'user' | 'assistant', text: string, msgId?: string): void {
    if (role === 'assistant') {
      this.items.push({ type: 'assistant_message', id: this.nextId('a'), ...(msgId ? { messageId: msgId } : {}), text });
      return;
    }
    // `!` runs ride into the next user message ahead of whatever the user typed (see
    // shell-exec.ts), so both halves have to come back out: a tile per run, then the message.
    const { runs, rest } = splitBashBlocks(text);
    if (runs.length > 0) {
      for (const r of runs) {
        this.items.push({ type: 'user_shell', id: this.nextId('sh'), command: r.command, stdout: r.stdout, stderr: r.stderr });
      }
      if (rest) this.items.push({ type: 'user_message', id: this.nextId('u'), text: rest });
      return;
    }
    const rewritten = rewriteSlashCommandInvocation(text);
    if (rewritten !== null) {
      this.items.push({ type: 'user_message', id: this.nextId('u'), text: rewritten });
      return;
    }
    if (isSystemInjection(text)) return;
    this.items.push({ type: 'user_message', id: this.nextId('u'), text });
  }

  private toolUse(b: RawContentBlock, msgId?: string): void {
    const rawName = typeof b.name === 'string' ? b.name : 'tool';
    const tool = canonicalToolName(rawName);
    const item: ToolCallItem = {
      type: 'tool_call',
      id: typeof b.id === 'string' ? b.id : this.nextId('t'),
      ...(msgId ? { messageId: msgId } : {}),
      kind: toolKind(tool),
      tool,
      rawName,
      input: b.input ?? {},
      status: 'completed',
    };
    if (typeof b.id === 'string') this.calls.set(b.id, item);
    this.items.push(item);
  }

  // A rejection is only the `toolUseResult` sidecar on the result line; its reason isn't in the JSONL.
  private toolResult(b: RawContentBlock, toolUseResult: unknown): void {
    const call = typeof b.tool_use_id === 'string' ? this.calls.get(b.tool_use_id) : undefined;
    if (!call) return;
    if (toolUseResult === 'User rejected tool use') call.status = 'declined';
    if (!PAIRED_TOOLS.has(call.tool)) return;
    const text = toolResultText(b.content);
    if (text) call.resultText = text;
  }

  private nextId(prefix: string): string {
    return `${prefix}${this.seq++}`;
  }
}

// Returns agent_id → completion. Handles both async (<task-notification> XML) and sync (toolUseResult sidecar) shapes.
// Scanned in file order and last-write-wins, so a SendMessage that resumed a finished agent
// clears its completion — the agent is running again until its next notification lands.
export function readTaskNotifications(parentJsonlPath: string): Map<string, SubagentCompletion> {
  const completions = new Map<string, SubagentCompletion>();
  let content: string;
  try {
    content = readFileSync(parentJsonlPath, 'utf8');
  } catch {
    return completions;
  }
  const parser = new LineParser();
  parser.onLine = (obj) => {
    const o = obj as RawSessionRecord & {
      timestamp?: string;
      toolUseResult?: { status?: string; agentId?: string; resumedAgentId?: string; content?: unknown };
    };

    // `to` is the raw agent id when the parent wakes a background agent; a teammate
    // name otherwise, which matches no key and drops out harmlessly.
    if (o.type === 'assistant') {
      const blocks = o.message?.content;
      if (!Array.isArray(blocks)) return;
      for (const block of blocks) {
        if (block.type !== 'tool_use' || block.name !== 'SendMessage') continue;
        const to = (block.input as { to?: unknown } | undefined)?.to;
        if (typeof to === 'string') completions.delete(to);
      }
      return;
    }
    if (o.type !== 'user') return;

    // A name-addressed send resolves to an agent id only in the result of the send.
    if (typeof o.toolUseResult?.resumedAgentId === 'string') {
      completions.delete(o.toolUseResult.resumedAgentId);
      return;
    }
    const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    const completedAt = Number.isNaN(ts) ? Date.now() : ts;

    // Sync shape: only stamp on terminal status; the same record also appears with 'async_launched' at dispatch.
    const tur = o.toolUseResult;
    if (tur && typeof tur.agentId === 'string' && tur.status && tur.status !== 'async_launched') {
      const completion: SubagentCompletion = { status: tur.status, completedAt };
      const summary = firstTextOfToolResult(o.message?.content);
      if (summary) completion.summary = summary;
      completions.set(tur.agentId, completion);
      return;
    }

    const c = o.message?.content;
    if (typeof c !== 'string') return;
    if (!c.trimStart().startsWith('<task-notification>')) return;
    const get = (tag: string): string | undefined => {
      const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
      const m = re.exec(c);
      return m ? m[1]!.trim() : undefined;
    };
    const taskId = get('task-id');
    if (!taskId) return;
    const completion: SubagentCompletion = {
      status: get('status') ?? 'completed',
      completedAt,
    };
    const summary = get('summary');
    if (summary) completion.summary = summary;
    const result = get('result');
    if (result) completion.result = result;
    completions.set(taskId, completion);
  };
  parser.write(content);
  return completions;
}

// Agent replies are two text blocks: [reply, metadata]. Return the first (reply); skip the metadata block.
function firstTextOfToolResult(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const b = block as RawContentBlock;
    if (b.type !== 'tool_result' || !Array.isArray(b.content)) continue;
    for (const inner of b.content) {
      const t = inner as RawContentBlock;
      if (t.type === 'text' && typeof t.text === 'string' && !t.text.startsWith('agentId:')) {
        return t.text.trim();
      }
    }
  }
  return undefined;
}
