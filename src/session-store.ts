import { readdirSync, readFileSync, statSync, unlinkSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LineParser } from './stream-json.js';

export interface SessionInfo {
  id: string;
  title: string;
  lastModified: number;
  path: string;
}

export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  text: string;
  // The owning assistant message's API id (`msg_*`). Present on assistant/tool_use entries
  // and used by the PWA to dedupe when the WS replay buffer re-delivers a message already
  // loaded from disk. Absent on user entries (claude doesn't assign API ids to user records).
  msgId?: string;
  // Structured fields for tool_use entries — carry the raw input alongside the rendered
  // string so the PWA can rebuild higher-level UI (e.g. the todos panel) from disk replay
  // without re-parsing the stringified `text`. Only set for Task* tools today, but the
  // shape is generic so we can opt other tools in later.
  toolName?: string;
  toolInput?: unknown;
  // Tool-use API id (`toolu_*`) that links a tool_use entry to its corresponding tool_result.
  // Set on both ends of the pair. Used by the PWA to resolve TaskCreate → assigned task id.
  toolUseId?: string;
}

// Tools whose tool_use+tool_result pair the PWA renders specially (todos panel, inline
// Ask Q&A card, etc) instead of as raw transcript entries. Listed here so session-store
// also surfaces the matching tool_result blocks, which it otherwise drops to keep
// transcript payloads small.
const PAIRED_TOOL_NAMES = new Set([
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'AskUserQuestion',
]);

// Claude Code injects synthetic "user" messages for local-command output, system reminders,
// command echoes, caveats, etc. They typically start with `<some-tag>`. Skip them so the
// session title reflects what the human actually typed.
function isSystemInjection(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<local-command-') ||
    t.startsWith('<command-') ||
    t.startsWith('<system-reminder>') ||
    t.startsWith('<bash-input>') ||
    t.startsWith('<bash-stdout>') ||
    // Synthetic user message Claude injects when a subagent (or backgrounded Bash task)
    // finishes. Useful context for Claude itself; pure XML noise to a human reader. The
    // PWA picks up the same blob on the live WS path and folds the result into the
    // matching agent's feed in the agents sheet — that's where it should be read.
    t.startsWith('<task-notification>') ||
    t.startsWith('Caveat: ');
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

interface RawSessionRecord {
  type?: string;
  message?: {
    id?: string;
    role?: string;
    content?: string | RawContentBlock[];
  };
}

// Read the file in chunks looking for the title sources, bailing out as soon as we've
// found both `summary` and a non-system-injected first user message. Avoids parsing whole
// session files (which can be megabytes) when all we need is the row title for the list view.
function scanTitleSources(path: string): { summary?: string; firstUserMsg?: string } {
  const fd = openSync(path, 'r');
  try {
    const CHUNK = 16 * 1024;
    const MAX = 256 * 1024; // bound so a freak file can't pin the CPU
    const buf = Buffer.alloc(CHUNK);
    let leftover = '';
    let offset = 0;
    let summary: string | undefined;
    let firstUserMsg: string | undefined;

    while (offset < MAX) {
      const bytes = readSync(fd, buf, 0, CHUNK, offset);
      if (bytes === 0) break;
      offset += bytes;
      const text = leftover + buf.subarray(0, bytes).toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      const consumable = lastNl === -1 ? text : text.slice(0, lastNl);
      leftover = lastNl === -1 ? text : text.slice(lastNl + 1);

      for (const line of consumable.split('\n')) {
        if (!line) continue;
        let obj: unknown;
        try { obj = JSON.parse(line); } catch { continue; }
        const o = obj as { type?: string; summary?: string; message?: { content?: string | unknown[] } };
        if (o.type === 'summary' && typeof o.summary === 'string' && !summary) summary = o.summary;
        if (o.type === 'user' && !firstUserMsg) {
          const c = o.message?.content;
          let t: string | undefined;
          if (typeof c === 'string') t = c;
          else if (Array.isArray(c)) {
            const tb = c.find((b): b is { type: 'text'; text: string } => (b as { type?: string })?.type === 'text');
            if (tb) t = tb.text;
          }
          if (t) {
            // Slash-command messages (/goal "..."  /investigate-cscu CSCU-42, etc.) get
            // injected as <command-name>X</command-name><command-args>actual user
            // intent</command-args>. The args ARE the user's intent — surface them as
            // the title source instead of skipping the whole message as a system
            // injection.
            const argsMatch = /<command-args>([\s\S]*?)<\/command-args>/.exec(t);
            const argsText = argsMatch ? argsMatch[1]?.trim() : '';
            if (argsText) {
              firstUserMsg = argsText;
            } else if (!isSystemInjection(t)) {
              firstUserMsg = t;
            }
          }
        }
        if (summary && firstUserMsg) return { summary, firstUserMsg };
      }
      if (bytes < CHUNK) break;
    }
    return { summary, firstUserMsg };
  } finally {
    closeSync(fd);
  }
}

// Title cleaner. Raw first-user-messages tend to start with filler ("can you look
// into…", "what's going on with…", "I'm trying to…") that wastes the limited row
// width. Strip those prefixes, recapitalize, and truncate cleanly. Best-effort
// heuristics — they're cheap, deterministic, and only apply when the prefix is
// clearly present.
function cleanTitle(raw: string): string {
  let t = raw.trim().replace(/\s+/g, ' ');
  // Order matters — longest/most-specific patterns first so "can you please look
  // into" doesn't get partially stripped to "please look into".
  const fillers: RegExp[] = [
    /^(?:hi|hey|hello)[,!.]?\s+(?:there[,!]?\s+)?/i,
    /^(?:can|could|would)\s+you\s+(?:please\s+)?(?:help\s+(?:me\s+)?(?:to\s+|with\s+)?)?(?:try\s+to\s+|maybe\s+)?/i,
    /^please\s+(?:can\s+you\s+)?/i,
    /^let'?s\s+/i,
    /^i\s+(?:want|need|would\s+like|am\s+trying|'m\s+trying)\s+(?:to|you\s+to)\s+/i,
    /^i'?d\s+like\s+(?:to|you\s+to)\s+/i,
    /^help\s+me\s+(?:to\s+|with\s+)?/i,
    /^help\s+(?:with\s+|me\s+)?/i,
    /^how\s+do\s+(?:i|we|you)\s+/i,
    /^tell\s+me\s+(?:about\s+|how\s+|why\s+)?/i,
    /^what'?s\s+(?:going\s+on|happening|up)\s+(?:with|in|on)\s+/i,
    /^what\s+is\s+(?:going\s+on\s+(?:with|in|on)\s+)?/i,
    /^why\s+is\s+/i,
    /^look\s+(?:in)?to\s+/i,
    /^check\s+(?:on\s+|out\s+)?/i,
    /^investigate\s+/i,
    /^do\s+(?:a\s+|the\s+|you\s+)/i,
    /^make\s+(?:me\s+|a\s+)?/i,
  ];
  // Chain: stripping "can you" should leave "look into X", which we then strip again
  // to "X". Bounded by filler count so it can't loop on a pathological pattern.
  for (let pass = 0; pass < fillers.length; pass++) {
    let changed = false;
    for (const re of fillers) {
      const stripped = t.replace(re, '');
      if (stripped !== t && stripped.length > 0) { t = stripped; changed = true; break; }
    }
    if (!changed) break;
  }
  // Capitalize first letter (only ASCII; non-ASCII strings just pass through).
  if (t && /[a-z]/.test(t.charAt(0))) t = t.charAt(0).toUpperCase() + t.slice(1);
  // Truncate at word boundary if too long. 60 chars matches the original behavior.
  if (t.length > 60) {
    const cut = t.slice(0, 60);
    const lastSpace = cut.lastIndexOf(' ');
    t = (lastSpace > 30 ? cut.slice(0, lastSpace) : cut) + '…';
  }
  return t || 'Untitled session';
}

// Flatten a tool_result block's content into a plain string. Claude emits these as either
// a single string or an array of {type:'text',text} parts; we only need the text for the
// PWA's todo-id resolution ("Task #N created successfully: ...").
function flattenToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const b of content) {
    if (b && typeof b === 'object' && (b as RawContentBlock).type === 'text') {
      const t = (b as RawContentBlock).text;
      if (typeof t === 'string') out.push(t);
    }
  }
  return out.join('\n');
}

function extractTranscriptMessages(obj: unknown, taskToolUseIds: Set<string>): TranscriptMessage[] {
  const o = obj as RawSessionRecord;
  if (o.type !== 'user' && o.type !== 'assistant') return [];
  const content = o.message?.content;
  const msgId = o.type === 'assistant' ? o.message?.id : undefined;

  if (typeof content === 'string') {
    if (o.type === 'user' && isSystemInjection(content)) return [];
    return [{ role: o.type, text: content, ...(msgId ? { msgId } : {}) }];
  }
  if (!Array.isArray(content)) return [];

  const parts: TranscriptMessage[] = [];
  for (const b of content) {
    if (b.type === 'text' && typeof b.text === 'string') {
      if (o.type === 'user' && isSystemInjection(b.text)) continue;
      parts.push({ role: o.type, text: b.text, ...(msgId ? { msgId } : {}) });
    } else if (b.type === 'tool_use' && o.type === 'assistant') {
      const name = typeof b.name === 'string' ? b.name : 'tool';
      const input = b.input ?? {};
      const inputStr = JSON.stringify(input).slice(0, 240);
      const useId = typeof b.id === 'string' ? b.id : undefined;
      // Track Task* tool calls so we can also surface their tool_result counterpart below —
      // those are needed to resolve TaskCreate's server-assigned task id.
      if (useId && PAIRED_TOOL_NAMES.has(name)) taskToolUseIds.add(useId);
      parts.push({
        role: 'tool_use',
        text: `${name}(${inputStr})`,
        toolName: name,
        toolInput: input,
        ...(useId ? { toolUseId: useId } : {}),
        ...(msgId ? { msgId } : {}),
      });
    } else if (b.type === 'tool_result' && o.type === 'user') {
      // Most tool_results are claude's internal feedback (file contents, bash output, etc.)
      // and would bloat the transcript — keep skipping those. The exception is Task* tool
      // results: the PWA needs them to learn the assigned task id from TaskCreate's response.
      const useId = typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined;
      if (!useId || !taskToolUseIds.has(useId)) continue;
      const text = flattenToolResultContent(b.content);
      if (!text) continue;
      parts.push({ role: 'tool_result', text, toolUseId: useId });
    }
  }
  return parts;
}

export class SessionStore {
  private readonly dir: string;

  constructor(opts: { dir: string }) {
    this.dir = opts.dir;
  }

  // Parse the session's .jsonl into a flat transcript suitable for display. Filters out
  // system-injected pseudo-user messages (caveats, command echoes, system reminders) so the
  // PWA only renders what the human actually said and what the assistant actually replied.
  readMessages(id: string): TranscriptMessage[] {
    if (!/^[\w-]+$/.test(id)) return [];
    const path = join(this.dir, `${id}.jsonl`);
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      return [];
    }
    const out: TranscriptMessage[] = [];
    // Per-session tracker so the linear pass knows which tool_result blocks to keep
    // (only those tied to a Task* tool_use we already saw earlier in the same file).
    const taskToolUseIds = new Set<string>();
    const parser = new LineParser();
    parser.onLine = (obj) => {
      for (const m of extractTranscriptMessages(obj, taskToolUseIds)) out.push(m);
    };
    parser.write(content);
    return out;
  }

  // Permanently remove a session's on-disk record. Use with care — the session is unrecoverable
  // after this. The Claude Code session store doesn't move files to a trash dir.
  delete(id: string): boolean {
    // Strict UUID-ish guard so a malformed id can't traverse into other directories.
    if (!/^[\w-]+$/.test(id)) return false;
    const path = join(this.dir, `${id}.jsonl`);
    try {
      unlinkSync(path);
      // Best-effort cleanup of the cached title sidecar. Ignored if absent.
      try { unlinkSync(join(this.dir, `${id}.title`)); } catch { /* no sidecar */ }
      return true;
    } catch {
      return false;
    }
  }

  list(): SessionInfo[] {
    let files: string[];
    try {
      files = readdirSync(this.dir);
    } catch {
      return [];
    }
    return files
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => this.read(join(this.dir, f)))
      .filter((s): s is SessionInfo => s !== null)
      .sort((a, b) => b.lastModified - a.lastModified);
  }

  private read(path: string): SessionInfo | null {
    try {
      const stat = statSync(path);
      const id = path.split('/').pop()!.replace(/\.jsonl$/, '');
      // Cached title sidecar — once a session's title has been computed from a real
      // source (summary or first-user-message) we persist it, so future reads use the
      // cached value and titles don't shift as new content streams in. Delete the
      // sidecar to force regeneration (e.g. after improving the heuristics).
      const titlePath = path.replace(/\.jsonl$/, '.title');
      let cached: string | undefined;
      try { cached = readFileSync(titlePath, 'utf8').trim(); } catch { /* no sidecar */ }
      if (cached) return { id, title: cached, lastModified: stat.mtimeMs, path };

      const { summary, firstUserMsg } = scanTitleSources(path);
      const rawTitle = summary ?? firstUserMsg;
      const title = rawTitle ? cleanTitle(rawTitle) : 'Untitled session';
      // Only persist when we found a real source — don't cache "Untitled session" for
      // a brand-new session that hasn't been written to disk yet.
      if (rawTitle) {
        try { writeFileSync(titlePath, title); } catch { /* best-effort cache */ }
      }
      return { id, title, lastModified: stat.mtimeMs, path };
    } catch {
      return null;
    }
  }
}
