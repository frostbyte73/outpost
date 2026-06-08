import { readdirSync, readFileSync, statSync, unlinkSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { LineParser } from './stream-json.js';

export interface SessionInfo {
  id: string;
  title: string;
  lastModified: number;
  path: string;
}

export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'tool_use';
  text: string;
  // The owning assistant message's API id (`msg_*`). Present on assistant/tool_use entries
  // and used by the PWA to dedupe when the WS replay buffer re-delivers a message already
  // loaded from disk. Absent on user entries (claude doesn't assign API ids to user records).
  msgId?: string;
}

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
    t.startsWith('Caveat: ');
}

interface RawContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
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
          if (t && !isSystemInjection(t)) firstUserMsg = t;
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

function extractTranscriptMessages(obj: unknown): TranscriptMessage[] {
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
      const input = JSON.stringify(b.input ?? {}).slice(0, 240);
      parts.push({ role: 'tool_use', text: `${name}(${input})`, ...(msgId ? { msgId } : {}) });
    }
    // tool_result blocks in user-type records are claude's feedback to itself, not human
    // content — skip them. The matching tool_use block in the prior assistant record already
    // gives the reader context for what happened.
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
    const parser = new LineParser();
    parser.onLine = (obj) => {
      for (const m of extractTranscriptMessages(obj)) out.push(m);
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
      // For the list view we only need the title; scan from the top and bail once we have
      // both candidate sources. This keeps cold-start fast even for sessions with hundreds
      // of turns. Read the file as a stream-ish chunk: pull in up to 64KB at a time and stop
      // when we have what we need.
      const { summary, firstUserMsg } = scanTitleSources(path);
      const title = summary ?? (firstUserMsg ? firstUserMsg.slice(0, 60) : 'Untitled session');
      return { id, title, lastModified: stat.mtimeMs, path };
    } catch {
      return null;
    }
  }
}
