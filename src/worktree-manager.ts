import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WorktreeRecord {
  sessionId: string;
  projectCwd: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  createdAt: number;
  // Tombstone marker: set when the session is archived. The path/branch fields are
  // cleared at that point — they no longer exist on disk — but we keep the tombstone
  // so SessionStore can surface the session as `archived: true`.
  archivedAt?: number;
}

interface PersistedShape {
  records: WorktreeRecord[];
}

export interface WorktreeManagerOpts {
  // Directory holding the index file and the per-session worktree subdirs.
  // Convention: `~/.outpost/worktrees`.
  root: string;
  // Claude's projects root (`~/.claude/projects`). Used by archive() to relocate the
  // session's JSONL from the worktree-derived project dir into the parent project's
  // dir, so `claude --resume <id>` can find it after the worktree is torn down.
  projectsRoot: string;
}

// Strict allowlist for sessionIds: UUID-shape characters only, must NOT start with `-`.
// The PWA generates these via crypto.randomUUID(); a path-traversal `../` or argv-injection
// `--flag` would either fail the regex or get rejected by the `--` separator passed to
// git below. Defense in depth — the daemon's WS routing also blocks suspicious sessionIds.
const SESSION_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
// Branch names per git-check-ref-format: letters, digits, underscore, dot, slash, dash.
// Must not start with a dash (else git argv parser treats it as a flag).
const BRANCH_NAME_RE = /^[A-Za-z0-9_./][A-Za-z0-9_./-]{0,128}$/;

export class WorktreeManager {
  private records = new Map<string, WorktreeRecord>();
  private readonly indexPath: string;
  protected readonly root: string;
  protected readonly projectsRoot: string;

  constructor(opts: WorktreeManagerOpts) {
    this.root = opts.root;
    this.projectsRoot = opts.projectsRoot;
    this.indexPath = join(this.root, 'index.json');
    this.load();
  }

  get(sessionId: string): WorktreeRecord | undefined {
    return this.records.get(sessionId);
  }

  list(): WorktreeRecord[] {
    return [...this.records.values()];
  }

  // Test-only seam: directly inject a record. Production callers use create()/archive(),
  // which actually invoke git. Underscored to discourage use elsewhere.
  _testSeedRecord(rec: WorktreeRecord): void {
    this.records.set(rec.sessionId, rec);
    this.persist();
  }

  private load(): void {
    if (!existsSync(this.indexPath)) return;
    try {
      const raw = readFileSync(this.indexPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedShape>;
      if (Array.isArray(parsed?.records)) {
        for (const r of parsed.records) {
          if (typeof r?.sessionId === 'string') this.records.set(r.sessionId, r);
        }
      }
    } catch {
      // Malformed — start empty. Will be overwritten on next persist().
    }
  }

  protected persist(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const tmp = `${this.indexPath}.tmp`;
    const payload: PersistedShape = { records: [...this.records.values()] };
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.indexPath);
  }

  async create(opts: { sessionId: string; projectCwd: string; baseBranch: string }): Promise<WorktreeRecord> {
    // Validate inputs — sessionId becomes a filesystem path component and baseBranch
    // is passed to git as a positional argument. Rejecting `../`, leading `-`, etc.
    // closes two classes of attack (path traversal + argv-flag smuggling).
    if (!SESSION_ID_RE.test(opts.sessionId)) {
      throw new Error(`invalid sessionId: ${JSON.stringify(opts.sessionId)}`);
    }
    if (!BRANCH_NAME_RE.test(opts.baseBranch)) {
      throw new Error(`invalid baseBranch: ${JSON.stringify(opts.baseBranch)}`);
    }
    if (this.records.has(opts.sessionId)) {
      throw new Error(`session ${opts.sessionId} already has a worktree`);
    }
    const shortId = opts.sessionId.replace(/-/g, '').slice(0, 8);
    const branch = `outpost/${shortId}`;
    const worktreePath = join(this.root, opts.sessionId);
    // Ensure the root exists before invoking git — fresh runtimeDirs (per-test temp
    // dirs in particular) may not have <root>/ created until the first worktree lands.
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const { execFileSync } = await import('node:child_process');
    // `--` separator: anything past it is treated as a positional, not a flag. Even
    // if the validation above missed something, git won't interpret a path or branch
    // starting with `-` as an option.
    execFileSync(
      'git',
      ['-C', opts.projectCwd, 'worktree', 'add', '-b', branch, '--', worktreePath, opts.baseBranch],
      { stdio: 'pipe' },
    );
    const rec: WorktreeRecord = {
      sessionId: opts.sessionId,
      projectCwd: opts.projectCwd,
      worktreePath,
      branch,
      baseBranch: opts.baseBranch,
      createdAt: Date.now(),
    };
    this.records.set(opts.sessionId, rec);
    this.persist();
    return rec;
  }

  async remove(sessionId: string): Promise<void> {
    const rec = this.records.get(sessionId);
    if (!rec) return; // idempotent
    await this.tearDown(rec);
    this.records.delete(sessionId);
    this.persist();
  }

  async archive(sessionId: string): Promise<void> {
    const rec = this.records.get(sessionId);
    if (!rec || rec.archivedAt) return;
    // Relocate the JSONL + sidecars into the parent project's dir BEFORE tearing the
    // worktree down. After this move, `claude --resume <id>` run with cwd=projectCwd
    // can find the session (claude looks under sanitize(cwd) in projectsRoot). Failing
    // to move would orphan the session — resume would land in an empty parent dir.
    this.relocateSessionFiles(rec);
    await this.tearDown(rec);
    // Tombstone fields worktreePath/branch are vestigial after relocation (kept on the
    // record for forensics; SessionStore no longer needs them to fold the row, since
    // the JSONL now lives directly under the parent project's dir).
    this.records.set(sessionId, {
      ...rec,
      archivedAt: Date.now(),
    });
    this.persist();
  }

  // Move `<projectsRoot>/<sanitize(worktreePath)>/<id>.{jsonl,title}` and the matching
  // `<id>/` subagent dir into `<projectsRoot>/<sanitize(projectCwd)>/`. Best-effort per
  // file — a missing sidecar doesn't poison the archive. Same-filesystem renames are
  // atomic, which is the common case here (both paths live under ~/.claude/projects/).
  private relocateSessionFiles(rec: WorktreeRecord): void {
    if (!rec.worktreePath) return;
    const fromDir = join(this.projectsRoot, rec.worktreePath.replace(/\//g, '-'));
    const toDir = join(this.projectsRoot, rec.projectCwd.replace(/\//g, '-'));
    if (!existsSync(fromDir)) return;
    mkdirSync(toDir, { recursive: true });
    for (const name of [`${rec.sessionId}.jsonl`, `${rec.sessionId}.title`, rec.sessionId]) {
      const src = join(fromDir, name);
      const dst = join(toDir, name);
      if (!existsSync(src)) continue;
      try { renameSync(src, dst); } catch { /* best-effort */ }
    }
    // Clean up the source dir if we emptied it. Leave it alone if anything remains
    // (orphan files from another session, or future claude-written sidecars we don't
    // know about) — better to leak an empty-ish dir than to lose data.
    try { if (readdirSync(fromDir).length === 0) rmdirSync(fromDir); } catch { /* leave it */ }
  }

  // Shared cleanup for remove() and archive(): nuke the worktree dir + delete the
  // branch, swallowing errors so a missing worktree-on-disk doesn't poison the call.
  private async tearDown(rec: WorktreeRecord): Promise<void> {
    if (!rec.worktreePath) return; // already torn down (tombstone)
    const { execFileSync } = await import('node:child_process');
    try {
      execFileSync(
        'git',
        ['-C', rec.projectCwd, 'worktree', 'remove', '--force', '--', rec.worktreePath],
        { stdio: 'pipe' },
      );
    } catch { /* path may already be gone */ }
    try {
      execFileSync(
        'git',
        ['-C', rec.projectCwd, 'branch', '-D', '--', rec.branch],
        { stdio: 'pipe' },
      );
    } catch { /* branch may already be gone */ }
  }
}
