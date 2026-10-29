import { closeSync, openSync, readSync } from 'node:fs';
import { isSystemInjection } from './transcript-parse.js';

// Chunked scan that bails as soon as both title sources are found; avoids parsing multi-MB session files.
export function scanTitleSources(path: string): { summary?: string; firstUserMsg?: string } {
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
            // For slash-command messages the args ARE the user's intent — use them as the title source.
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

export function cleanTitle(raw: string): string {
  let t = raw.trim().replace(/\s+/g, ' ');
  // Order matters — longest/most-specific patterns first so partial-strip doesn't leave a stub.
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
  // Chain strips; bounded by filler count so a pathological pattern can't loop.
  for (let pass = 0; pass < fillers.length; pass++) {
    let changed = false;
    for (const re of fillers) {
      const stripped = t.replace(re, '');
      if (stripped !== t && stripped.length > 0) { t = stripped; changed = true; break; }
    }
    if (!changed) break;
  }
  if (t && /[a-z]/.test(t.charAt(0))) t = t.charAt(0).toUpperCase() + t.slice(1);
  if (t.length > 60) {
    const cut = t.slice(0, 60);
    const lastSpace = cut.lastIndexOf(' ');
    t = (lastSpace > 30 ? cut.slice(0, lastSpace) : cut) + '…';
  }
  return t || 'Untitled session';
}

type TailRecord = { type?: string; timestamp?: string; isMeta?: boolean; isSidechain?: boolean; message?: { content?: unknown } };

// Claude's own prose to the user is what makes a session unread
function isAssistantReply(o: TailRecord): boolean {
  if (o.type !== 'assistant' || o.isSidechain) return false;
  const c = o.message?.content;
  if (!Array.isArray(c)) return false;
  return c.some((b) => {
    const blk = b as { type?: string; text?: unknown };
    return blk?.type === 'text' && typeof blk.text === 'string' && blk.text.trim() !== '';
  });
}

function isTypedPrompt(o: TailRecord): boolean {
  if (o.type !== 'user' || o.isMeta) return false;
  const c = o.message?.content;
  if (typeof c === 'string') return !isSystemInjection(c);
  if (!Array.isArray(c)) return false;
  if (c.some((b) => (b as { type?: string })?.type === 'tool_result')) return false;
  return c.some((b) => {
    const blk = b as { type?: string; text?: unknown };
    return blk?.type === 'text' && !isSystemInjection(String(blk.text ?? ''));
  });
}

// Tail-scan for the newest user/assistant timestamp and the newest typed prompt; sort keys must be
// real activity, not mtime — `claude --resume` appends non-content lines that bump mtime.
export function tailTimestamps(path: string, size: number): { last: number | null; prompt: number | null; reply: number | null } {
  const TAIL_BYTES = 64 * 1024;
  const start = Math.max(0, size - TAIL_BYTES);
  const len = size - start;
  if (len <= 0) return { last: null, prompt: null, reply: null };
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    // Drop leading partial record if we started mid-line.
    const firstNl = start === 0 ? -1 : text.indexOf('\n');
    const lines = (firstNl === -1 ? text : text.slice(firstNl + 1)).split('\n');
    let last: number | null = null;
    let prompt: number | null = null;
    let reply: number | null = null;
    for (let i = lines.length - 1; i >= 0 && (last === null || prompt === null || reply === null); i--) {
      const line = lines[i];
      if (!line) continue;
      let o: TailRecord;
      try { o = JSON.parse(line) as TailRecord; } catch { continue; }
      if ((o.type !== 'user' && o.type !== 'assistant') || typeof o.timestamp !== 'string') continue;
      const ms = Date.parse(o.timestamp);
      if (!Number.isFinite(ms)) continue;
      if (last === null) last = ms;
      if (prompt === null && isTypedPrompt(o)) prompt = ms;
      if (reply === null && isAssistantReply(o)) reply = ms;
    }
    return { last, prompt, reply };
  } finally {
    closeSync(fd);
  }
}

export function firstCwdInJsonl(path: string): string | null {
  const fd = openSync(path, 'r');
  try {
    const CHUNK = 16 * 1024;
    const MAX = 256 * 1024;
    const buf = Buffer.alloc(CHUNK);
    let leftover = '';
    let offset = 0;

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
        try {
          const o = JSON.parse(line) as { cwd?: unknown };
          if (typeof o.cwd === 'string' && o.cwd.length > 0) return o.cwd;
        } catch { /* one bad record shouldn't poison the read */ }
      }
      if (bytes < CHUNK) break;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}
