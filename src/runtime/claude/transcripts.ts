import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LineParser } from '../../session/stream-json.js';
import { TranscriptItemParser, readTaskNotifications, type RawSessionRecord } from './transcript-parse.js';
import { cleanTitle, firstCwdInJsonl, scanTitleSources, tailTimestamps } from './transcript-scan.js';
import type {
  CanonicalItem, SessionInfo, SubagentInfo, TranscriptProject, TranscriptReader,
} from '../types.js';

// Claude Code's session history: one JSONL per session under ~/.claude/projects/<sanitized-cwd>/.
export class ClaudeTranscripts implements TranscriptReader {
  private cwdCache = new Map<string, { cwd: string; mtime: number }>();
  // JSONL is append-only, so size unchanged ⇒ cached timestamp still valid.
  private lastMsgTsCache = new Map<string, { size: number; ts: number | null; prompt: number | null; reply: number | null }>();

  constructor(private readonly root: string) {}

  projectDirFor(cwd: string): string {
    return join(this.root, cwd.replace(/\//g, '-'));
  }

  // One entry per physical ~/.claude/projects/* dir — NO cwd collapse. Callers that
  // resolve a session id back to the dir its JSONL physically lives in rely on entries
  // staying 1:1 with dirs.
  scanProjectDirs(knownWorktreePaths: ReadonlySet<string>): TranscriptProject[] {
    let dirs: string[];
    try {
      dirs = readdirSync(this.root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(this.root, e.name));
    } catch {
      dirs = [];
    }
    const out: TranscriptProject[] = [];
    for (const projectDir of dirs) {
      const cwd = this.readCwdFromProject(projectDir);
      if (!cwd) continue;
      let cwdExists = false;
      try { cwdExists = statSync(cwd).isDirectory(); } catch { /* nope */ }
      // Drop dead cwds unless they're a known worktree (live or tombstoned) — those still get merged.
      if (!cwdExists && !knownWorktreePaths.has(cwd)) continue;
      const sessions = this.listSessionsInDir(projectDir);
      const lastModified = sessions.reduce((m, s) => Math.max(m, s.lastModified), 0);
      out.push({ projectDir, cwd, lastModified, sessions });
    }
    return out;
  }

  readCwdFromProject(projectDir: string): string | null {
    let entries: { name: string; mtime: number }[];
    try {
      entries = readdirSync(projectDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const p = join(projectDir, f);
          const st = statSync(p);
          return { name: p, mtime: st.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      return null;
    }
    if (entries.length === 0) return null;
    const newest = entries[0]!;
    const cached = this.cwdCache.get(projectDir);
    if (cached && cached.mtime === newest.mtime) return cached.cwd;
    // Prefer a cwd whose sanitization matches this dir's basename — without this, a relocated
    // worktree JSONL (archive() moves it into the parent's dir) would hijack the parent's cwd.
    const expectedBasename = projectDir.split('/').pop() ?? '';
    let fallback: string | null = null;
    for (const e of entries) {
      const cwd = firstCwdInJsonl(e.name);
      if (!cwd) continue;
      if (cwd.replace(/\//g, '-') === expectedBasename) {
        this.cwdCache.set(projectDir, { cwd, mtime: newest.mtime });
        return cwd;
      }
      if (fallback === null) fallback = cwd;
    }
    if (fallback !== null) this.cwdCache.set(projectDir, { cwd: fallback, mtime: newest.mtime });
    return fallback;
  }

  readItems(projectDir: string, id: string): CanonicalItem[] {
    let content: string;
    try {
      content = readFileSync(join(projectDir, `${id}.jsonl`), 'utf8');
    } catch {
      return [];
    }
    const items = new TranscriptItemParser();
    const parser = new LineParser();
    parser.onLine = (obj) => items.push(obj);
    parser.write(content);
    return items.items;
  }

  // Reconstruct each subagent's transcript from <sessionDir>/<sessionId>/subagents/agent-<id>.{jsonl,meta.json},
  // binding completion data from the parent JSONL's <task-notification> entries by task-id = agent_id.
  readSubagents(projectDir: string, id: string): SubagentInfo[] {
    const subagentDir = join(projectDir, id, 'subagents');
    let metaFiles: string[];
    try {
      metaFiles = readdirSync(subagentDir).filter((f) => f.endsWith('.meta.json'));
    } catch {
      return [];
    }
    const completions = readTaskNotifications(join(projectDir, `${id}.jsonl`));
    const out: SubagentInfo[] = [];
    for (const metaFile of metaFiles) {
      const agentId = metaFile.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
      const jsonlPath = join(subagentDir, `agent-${agentId}.jsonl`);
      let meta: { agentType?: string; description?: string; toolUseId?: string };
      try {
        meta = JSON.parse(readFileSync(join(subagentDir, metaFile), 'utf8'));
      } catch {
        continue;
      }
      let jsonlContent = '';
      let firstSeenAt = 0;
      try {
        jsonlContent = readFileSync(jsonlPath, 'utf8');
        firstSeenAt = statSync(jsonlPath).mtimeMs;
      } catch { /* meta without jsonl — surface with empty feed */ }
      const items = new TranscriptItemParser();
      let firstTimestamp: number | null = null;
      const parser = new LineParser();
      parser.onLine = (obj) => {
        const o = obj as RawSessionRecord & { timestamp?: string };
        if (firstTimestamp === null && typeof o.timestamp === 'string') {
          const t = Date.parse(o.timestamp);
          if (!Number.isNaN(t)) firstTimestamp = t;
        }
        items.push(obj);
      };
      parser.write(jsonlContent);
      out.push({
        agentId,
        agentType: meta.agentType ?? 'agent',
        ...(meta.description ? { description: meta.description } : {}),
        ...(meta.toolUseId ? { parentToolUseId: meta.toolUseId } : {}),
        firstSeenAt: firstTimestamp ?? firstSeenAt,
        // Subagent feeds render only tool tiles; the dispatch prompt and free-form replies live elsewhere.
        entries: items.items.filter((i) => i.type === 'tool_call'),
        completion: completions.get(agentId) ?? null,
      });
    }
    out.sort((a, b) => a.firstSeenAt - b.firstSeenAt);
    return out;
  }

  deleteTranscript(projectDir: string, id: string): boolean {
    try {
      unlinkSync(join(projectDir, `${id}.jsonl`));
    } catch {
      return false;
    }
    try { unlinkSync(join(projectDir, `${id}.title`)); } catch { /* no sidecar */ }
    return true;
  }

  private listSessionsInDir(dir: string): SessionInfo[] {
    let files: string[];
    try { files = readdirSync(dir); } catch { return []; }
    return files
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => this.readSessionInfoFromPath(join(dir, f)))
      .filter((s): s is SessionInfo => s !== null)
      .sort((a, b) => b.lastModified - a.lastModified);
  }

  private readSessionInfoFromPath(path: string): SessionInfo | null {
    try {
      const stat = statSync(path);
      const id = path.split('/').pop()!.replace(/\.jsonl$/, '');
      const act = this.activity(path, stat.size, stat.mtimeMs, stat.birthtimeMs);
      // Persisted sidecar so titles don't shift as new content streams in; delete to force regeneration.
      const titlePath = path.replace(/\.jsonl$/, '.title');
      let cached: string | undefined;
      try { cached = readFileSync(titlePath, 'utf8').trim(); } catch { /* no sidecar */ }
      if (cached) return { id, title: cached, ...act, path };
      const { summary, firstUserMsg } = scanTitleSources(path);
      const rawTitle = summary ?? firstUserMsg;
      // Don't cache "Untitled session" for a brand-new session that hasn't been written to disk yet.
      if (rawTitle) {
        try { writeFileSync(titlePath, cleanTitle(rawTitle)); } catch { /* best-effort cache */ }
      }
      return { id, title: rawTitle ? cleanTitle(rawTitle) : 'Untitled session', ...act, path };
    } catch {
      return null;
    }
  }

  // Falls back to mtime so a brand-new session with no real turns yet still sorts to the top.
  // The JSONL is append-only, so a prompt a long agent turn pushed out of the tail is still the
  // newest one; with none ever seen, creation stands in — never agent activity.
  private activity(path: string, size: number, mtimeMs: number, birthtimeMs: number): { lastModified: number; lastEngagedAt: number; lastReplyAt?: number } {
    let cached = this.lastMsgTsCache.get(path);
    if (!cached || cached.size !== size) {
      const { last, prompt, reply } = tailTimestamps(path, size);
      cached = { size, ts: last, prompt: prompt ?? cached?.prompt ?? null, reply: reply ?? cached?.reply ?? null };
      this.lastMsgTsCache.set(path, cached);
    }
    return {
      lastModified: cached.ts ?? mtimeMs,
      lastEngagedAt: cached.prompt ?? birthtimeMs,
      ...(cached.reply !== null ? { lastReplyAt: cached.reply } : {}),
    };
  }
}
