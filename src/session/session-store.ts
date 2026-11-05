import { readFileSync, statSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { uploadsRootFor } from './attachments.js';
import { join } from 'node:path';
import { removeNdjsonLogs } from '../runtime/event-ndjson.js';
import type { ProjectRegistry } from '../storage/project-registry.js';
import type { WorktreeManager, WorktreeRecord } from '../git/worktree-manager.js';
import type {
  CanonicalItem, ProjectInfo, SessionLocation, SubagentInfo, TranscriptReader,
} from '../runtime/types.js';

// Sessions older than this with no active worktree are stamped archived at read time.
// Active worktrees are exempt so long-running branches don't vanish at the 7d mark.
const AUTO_ARCHIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function stampAutoArchived(projects: ProjectInfo[]): void {
  const ageCutoff = Date.now() - AUTO_ARCHIVE_WINDOW_MS;
  for (const p of projects) {
    for (let i = 0; i < p.sessions.length; i++) {
      const s = p.sessions[i]!;
      if (s.archived) continue;
      if (s.lastModified < ageCutoff && !s.worktreePath) {
        p.sessions[i] = { ...s, archived: true };
      }
    }
  }
}

// Every session: the runtime's history folded by project and worktree, plus the daemon's own sidecar meta.
export class SessionStore {
  private readonly transcripts: TranscriptReader;
  private readonly registry: ProjectRegistry | undefined;
  private readonly worktreeManager: WorktreeManager | undefined;
  private readonly sessionMetaDir: string | undefined;
  private readonly runtimeDir: string | undefined;
  private readonly runtimeLogDir: string | undefined;
  // Never invalidated within a daemon lifetime — restart picks up new git inits.
  private gitRepoCache = new Map<string, boolean>();

  constructor(opts: {
    transcripts: TranscriptReader;
    registry?: ProjectRegistry;
    worktreeManager?: WorktreeManager;
    sessionMetaDir?: string;
    runtimeDir?: string;
    runtimeLogDir?: string;
  }) {
    this.transcripts = opts.transcripts;
    this.registry = opts.registry;
    this.worktreeManager = opts.worktreeManager;
    this.sessionMetaDir = opts.sessionMetaDir;
    this.runtimeDir = opts.runtimeDir;
    this.runtimeLogDir = opts.runtimeLogDir;
  }

  // Durable per-session marker written when Outpost spawns an action session
  // (orchestrator, step, or action/skill edit): the action name + a readable title.
  // Lets the sessions list label + title action sessions without their transcript,
  // and survives daemon restarts (unlike the in-memory action binding). Keyed by
  // session id, so it's independent of the runtime's own history layout.
  writeActionMeta(sessionId: string, meta: { action: string; title: string }): void {
    this.mergeSessionMeta(sessionId, meta);
  }

  // The per-session vars the daemon spawned this session with (`OUTPOST_ENVELOPE` and its
  // job/step ids). Persisted because the respawn is not always the daemon's: the PWA attaching
  // to an idle-reaped session respawns it with no env of its own, and sendOrResume then finds
  // it live and never gets to apply any — leaving a step session unable to read its envelope
  // for the rest of its life. Never holds the hook secret; only the caller's `extraEnv`.
  writeSpawnEnv(sessionId: string, env: Record<string, string>): void {
    this.mergeSessionMeta(sessionId, { spawnEnv: env });
  }

  readSpawnEnv(id: string): Record<string, string> | null {
    const env = this.readSessionMeta(id)?.spawnEnv;
    return env && typeof env === 'object' ? env as Record<string, string> : null;
  }

  // Extra system prompt for a session the daemon seeded with context (a wait-step session).
  // Persisted for the same reason as spawnEnv: every respawn, whoever triggers it, must carry it.
  writeSystemPrompt(sessionId: string, text: string): void {
    this.mergeSessionMeta(sessionId, { systemPrompt: text });
  }

  readSystemPrompt(id: string): string | null {
    const text = this.readSessionMeta(id)?.systemPrompt;
    return typeof text === 'string' ? text : null;
  }

  // Both writers own their own keys of one shared sidecar, and the action stamp lands right
  // after the spawn — a whole-file write from either would drop the other's.
  private mergeSessionMeta(sessionId: string, fields: Record<string, unknown>): void {
    if (!this.sessionMetaDir || !/^[\w-]+$/.test(sessionId)) return;
    try {
      mkdirSync(this.sessionMetaDir, { recursive: true, mode: 0o700 });
      const path = join(this.sessionMetaDir, `${sessionId}.json`);
      const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
      writeFileSync(tmp, JSON.stringify({ ...this.readSessionMeta(sessionId), ...fields }), { mode: 0o600 });
      renameSync(tmp, path);
    } catch { /* best-effort — the session just renders as a plain interactive one */ }
  }

  private readSessionMeta(id: string): Record<string, unknown> | null {
    if (!this.sessionMetaDir || !/^[\w-]+$/.test(id)) return null;
    try {
      const parsed = JSON.parse(readFileSync(join(this.sessionMetaDir, `${id}.json`), 'utf8')) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch { return null; }
  }

  private readActionMeta(id: string): { action: string; title: string } | null {
    const parsed = this.readSessionMeta(id);
    if (typeof parsed?.action !== 'string') return null;
    return { action: parsed.action, title: typeof parsed.title === 'string' ? parsed.title : '' };
  }

  private isGitRepo(cwd: string): boolean {
    const cached = this.gitRepoCache.get(cwd);
    if (cached !== undefined) return cached;
    let result = false;
    try {
      const st = statSync(join(cwd, '.git'));
      result = st.isDirectory() || st.isFile();
    } catch { /* not a repo */ }
    this.gitRepoCache.set(cwd, result);
    return result;
  }

  // One ProjectInfo per physical history dir — NO cwd collapse. Callers that resolve a
  // session id back to the dir its transcript physically lives in (findSession, and thus
  // readItems/delete/subagents) rely on entries staying 1:1 with dirs. Collapsing here would
  // hand back a representative projectDir that's wrong for any session merged in from a sibling dir.
  private scanProjectDirs(): ProjectInfo[] {
    // Include tombstoned worktree paths so their transcripts survive archive/remove (folded under parent later).
    const knownWorktreePaths = new Set<string>();
    for (const rec of this.worktreeManager?.list() ?? []) {
      if (rec.worktreePath) knownWorktreePaths.add(rec.worktreePath);
    }
    return this.transcripts.scanProjectDirs(knownWorktreePaths).map((p) => ({
      ...p,
      // An action session's stamped title/label supersedes the transcript-derived one
      // (whose first turn is a bare `/action <uuid>` slash command → a UUID or "Untitled").
      sessions: p.sessions.map((s) => {
        const meta = this.readActionMeta(s.id);
        return meta ? { ...s, title: meta.title || s.title, sessionClass: 'action' as const, actionLabel: meta.action } : s;
      }),
      isGitRepo: this.isGitRepo(p.cwd),
      source: 'claude' as const,
    }));
  }

  // Physical dirs collapsed to one ProjectInfo per cwd, for the cwd-grouped project list. Two
  // history dirs can resolve to the same cwd — most often a worktree dir whose session
  // recorded the PARENT repo's cwd, which defeats the runtime's cwd guard and makes
  // the worktree dir claim the parent's cwd. Union the sessions rather than let the later dir
  // clobber the earlier (that silently drops a whole project), and keep the dir whose basename
  // matches the sanitized cwd as the representative — the canonical home for that cwd.
  private scanRawProjects(): ProjectInfo[] {
    const byCwd = new Map<string, ProjectInfo>();
    for (const p of this.scanProjectDirs()) {
      const existing = byCwd.get(p.cwd);
      if (!existing) {
        byCwd.set(p.cwd, p);
        continue;
      }
      const incomingIsCanonical = p.projectDir === this.transcripts.projectDirFor(p.cwd);
      const seen = new Set(existing.sessions.map((s) => s.id));
      const sessions = [...existing.sessions];
      for (const s of p.sessions) if (!seen.has(s.id)) sessions.push(s);
      sessions.sort((a, b) => b.lastModified - a.lastModified);
      byCwd.set(p.cwd, {
        ...existing,
        projectDir: incomingIsCanonical ? p.projectDir : existing.projectDir,
        sessions,
        lastModified: Math.max(existing.lastModified, p.lastModified),
        isGitRepo: existing.isGitRepo || p.isGitRepo,
      });
    }
    if (this.registry) {
      for (const reg of this.registry.list()) {
        let cwdExists = false;
        try { cwdExists = statSync(reg.cwd).isDirectory(); } catch { /* nope */ }
        if (!cwdExists) continue;
        const existing = byCwd.get(reg.cwd);
        if (existing) {
          byCwd.set(reg.cwd, { ...existing, source: 'both' });
        } else {
          byCwd.set(reg.cwd, {
            projectDir: this.transcripts.projectDirFor(reg.cwd),
            cwd: reg.cwd,
            lastModified: reg.addedAt,
            sessions: [],
            isGitRepo: this.isGitRepo(reg.cwd),
            source: 'registry',
          });
        }
      }
    }
    return [...byCwd.values()];
  }

  listProjects(): ProjectInfo[] {
    const raw = this.scanRawProjects();
    if (!this.worktreeManager) {
      raw.sort((a, b) => b.lastModified - a.lastModified);
      stampAutoArchived(raw);
      return this.stampInternal(raw);
    }

    // Tombstones included so their transcripts fold under the parent project as archived rows, not orphans.
    const worktreeByCwd = new Map<string, WorktreeRecord>();
    for (const rec of this.worktreeManager.list()) {
      if (!rec.worktreePath) continue;
      worktreeByCwd.set(rec.worktreePath, rec);
    }
    const archivedSessionIds = new Set<string>();
    for (const rec of this.worktreeManager.list()) {
      if (rec.archivedAt) archivedSessionIds.add(rec.sessionId);
    }

    const parents = new Map<string, ProjectInfo>();
    const orphanWorktreeRows: { project: ProjectInfo; rec: WorktreeRecord }[] = [];
    for (const p of raw) {
      const rec = worktreeByCwd.get(p.cwd);
      if (rec) {
        orphanWorktreeRows.push({ project: p, rec });
      } else {
        parents.set(p.cwd, p);
      }
    }

    // Fold each worktree row into its parent project, synthesizing a parent if none exists.
    for (const { project: wtProject, rec } of orphanWorktreeRows) {
      let parent = parents.get(rec.projectCwd);
      if (!parent) {
        let cwdExists = false;
        try { cwdExists = statSync(rec.projectCwd).isDirectory(); } catch { /* nope */ }
        if (!cwdExists) continue;  // parent dir gone — drop the orphan rows
        parent = {
          projectDir: this.transcripts.projectDirFor(rec.projectCwd),
          cwd: rec.projectCwd,
          lastModified: 0,
          sessions: [],
          isGitRepo: this.isGitRepo(rec.projectCwd),
          source: 'claude',
        };
        parents.set(rec.projectCwd, parent);
      }
      const annotated = wtProject.sessions.map((s) => ({
        ...s,
        worktreePath: rec.worktreePath,
        worktreeBranch: rec.branch,
      }));
      parent.sessions = [...parent.sessions, ...annotated];
      parent.lastModified = Math.max(parent.lastModified, wtProject.lastModified);
    }

    for (const p of parents.values()) {
      for (let i = 0; i < p.sessions.length; i++) {
        if (archivedSessionIds.has(p.sessions[i]!.id)) {
          p.sessions[i] = { ...p.sessions[i]!, archived: true };
        }
      }
      p.sessions.sort((a, b) => b.lastModified - a.lastModified);
    }
    stampAutoArchived([...parents.values()]);

    const out = [...parents.values()];
    out.sort((a, b) => b.lastModified - a.lastModified);
    return this.stampInternal(out);
  }

  private stampInternal(projects: ProjectInfo[]): ProjectInfo[] {
    if (!this.runtimeDir) return projects;
    const prefix = this.runtimeDir.endsWith('/') ? this.runtimeDir : `${this.runtimeDir}/`;
    for (const p of projects) if (p.cwd.startsWith(prefix)) p.internal = true;
    return projects;
  }

  findSession(id: string): SessionLocation | null {
    // Use the per-dir scan so a session resolves to the physical dir its transcript lives in, never a
    // cwd-collapsed representative — otherwise a session merged in from a sibling dir would resolve
    // to the wrong projectDir and readItems/delete would target a file that isn't there.
    for (const p of this.scanProjectDirs()) {
      const match = p.sessions.find((s) => s.id === id);
      if (match) return { projectDir: p.projectDir, cwd: p.cwd, session: match };
    }
    return null;
  }

  readItems(id: string): CanonicalItem[] {
    // Strict id guard prevents path traversal into other directories.
    if (!/^[\w-]+$/.test(id)) return [];
    const found = this.findSession(id);
    return found ? this.transcripts.readItems(found.projectDir, id) : [];
  }

  readSubagents(id: string): SubagentInfo[] {
    if (!/^[\w-]+$/.test(id)) return [];
    const found = this.findSession(id);
    return found ? this.transcripts.readSubagents(found.projectDir, id) : [];
  }

  // Permanently removes the session — no trash dir, not recoverable.
  delete(id: string): boolean {
    if (!/^[\w-]+$/.test(id)) return false;
    const found = this.findSession(id);
    if (!found || !this.transcripts.deleteTranscript(found.projectDir, id)) return false;
    if (this.sessionMetaDir) rmSync(join(this.sessionMetaDir, `${id}.json`), { force: true });
    if (this.runtimeDir) rmSync(join(uploadsRootFor(this.runtimeDir), id), { recursive: true, force: true });
    if (this.runtimeLogDir) removeNdjsonLogs(this.runtimeLogDir, id);
    return true;
  }
}
