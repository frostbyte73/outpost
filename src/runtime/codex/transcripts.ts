import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { CanonicalItem, SessionInfo, SubagentInfo, TranscriptProject, TranscriptReader } from '../types.js';

const TITLE_CHARS = 80;

// Outpost's own record of each Codex session: line 1 is `{cwd}`, then one canonical item per line.
export class CodexTranscripts implements TranscriptReader {
  constructor(readonly root: string) {}

  projectDirFor(cwd: string): string {
    return join(this.root, cwd.replace(/\//g, '-'));
  }

  append(sessionId: string, cwd: string, item: CanonicalItem): void {
    const dir = this.projectDirFor(cwd);
    const path = join(dir, `${sessionId}.jsonl`);
    if (!existsSync(path)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      appendFileSync(path, `${JSON.stringify({ cwd })}\n`, { mode: 0o600 });
    }
    appendFileSync(path, `${JSON.stringify(item)}\n`);
  }

  scanProjectDirs(knownWorktreePaths: ReadonlySet<string>): TranscriptProject[] {
    let dirs: string[];
    try { dirs = readdirSync(this.root).map((d) => join(this.root, d)); } catch { return []; }
    const out: TranscriptProject[] = [];
    for (const projectDir of dirs) {
      const sessions = this.listSessions(projectDir);
      const cwd = sessions[0] && this.readLines(sessions[0].path)[0]?.cwd;
      if (typeof cwd !== 'string') continue;
      let cwdExists = false;
      try { cwdExists = statSync(cwd).isDirectory(); } catch { /* gone */ }
      if (!cwdExists && !knownWorktreePaths.has(cwd)) continue;
      out.push({ projectDir, cwd, lastModified: Math.max(...sessions.map((s) => s.lastModified)), sessions });
    }
    return out;
  }

  readItems(projectDir: string, id: string): CanonicalItem[] {
    return this.readLines(join(projectDir, `${id}.jsonl`)).slice(1) as unknown as CanonicalItem[];
  }

  readSubagents(): SubagentInfo[] {
    return [];
  }

  deleteTranscript(projectDir: string, id: string): boolean {
    try { unlinkSync(join(projectDir, `${id}.jsonl`)); return true; } catch { return false; }
  }

  private listSessions(dir: string): SessionInfo[] {
    let files: string[];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
    return files.map((f) => {
      const path = join(dir, f);
      const first = this.readLines(path).find((l) => l.type === 'user_message');
      const title = typeof first?.text === 'string' && first.text.trim() ? first.text.trim().slice(0, TITLE_CHARS) : 'Untitled session';
      return { id: f.replace(/\.jsonl$/, ''), title, lastModified: statSync(path).mtimeMs, path };
    }).sort((a, b) => b.lastModified - a.lastModified);
  }

  private readLines(path: string): Record<string, unknown>[] {
    let raw: string;
    try { raw = readFileSync(path, 'utf8'); } catch { return []; }
    const out: Record<string, unknown>[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line) as Record<string, unknown>); } catch { /* torn tail line */ }
    }
    return out;
  }
}
