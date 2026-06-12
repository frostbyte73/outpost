import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
    // `--` separator: anything past it is treated as a positional, not a flag. Even
    // if the validation above missed something, git won't interpret a path or branch
    // starting with `-` as an option.
    execFileSync(
      'git',
      ['-C', opts.projectCwd, 'worktree', 'add', '-b', branch, '--', worktreePath, opts.baseBranch],
      { stdio: 'pipe' },
    );
    copyAllowlistedIgnored(opts.projectCwd, worktreePath);
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
    if (rec) {
      await this.tearDown(rec);
      this.records.delete(sessionId);
      this.persist();
      return;
    }
    // No in-memory record. Most often idempotent, but can also be the dual-daemon
    // case: another instance created the worktree, this instance never saw the index
    // update, and now a delete arrived here. Probe disk so the branch + worktree dir
    // don't leak — derive the parent repo from the worktree's .git pointer file.
    if (!SESSION_ID_RE.test(sessionId)) return;
    const orphanPath = join(this.root, sessionId);
    const projectCwd = readParentRepoFromGitFile(orphanPath);
    if (!projectCwd) return;
    const shortId = sessionId.replace(/-/g, '').slice(0, 8);
    await this.tearDown({
      sessionId,
      projectCwd,
      worktreePath: orphanPath,
      branch: `outpost/${shortId}`,
      baseBranch: '',
      createdAt: 0,
    });
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
    try {
      execFileSync(
        'git',
        ['-C', rec.projectCwd, 'worktree', 'remove', '--force', '--', rec.worktreePath],
        { stdio: 'pipe' },
      );
    } catch { /* path may already be gone */ }
    // Prune any stale .git/worktrees/<id> entry left by a previous failed/partial
    // removal — otherwise the next branch -D fails with "branch is checked out at …"
    // and we silently leak the branch.
    try {
      execFileSync('git', ['-C', rec.projectCwd, 'worktree', 'prune'], { stdio: 'pipe' });
    } catch { /* best-effort */ }
    try {
      execFileSync(
        'git',
        ['-C', rec.projectCwd, 'branch', '-D', '--', rec.branch],
        { stdio: 'pipe' },
      );
    } catch { /* branch may already be gone */ }
  }
}

export type DiffMode = 'branch' | 'worktree';

// Run `git diff` for a worktree record in one of two modes. Returns UTF-8 stdout.
// Argv-only — no shell. The sessionId/branch regexes upstream and the `--` separator
// below keep ref/path inputs from being parsed as flags. Throws if the record is
// tombstoned (worktreePath cleared).
export function runGitDiff(rec: WorktreeRecord, mode: DiffMode): string {
  if (!rec.worktreePath) throw new Error('cannot diff a tombstoned worktree record');
  const baseBranch = rec.baseBranch && rec.baseBranch.length > 0 ? rec.baseBranch : 'main';
  if (!BRANCH_NAME_RE.test(baseBranch)) throw new Error(`invalid baseBranch: ${JSON.stringify(baseBranch)}`);
  if (!BRANCH_NAME_RE.test(rec.branch)) throw new Error(`invalid branch: ${JSON.stringify(rec.branch)}`);

  const args = mode === 'branch'
    ? ['-C', rec.projectCwd, 'diff', '--no-color', '--find-renames', '-U3', `${baseBranch}...${rec.branch}`, '--']
    : ['-C', rec.worktreePath, 'diff', '--no-color', '--find-renames', '-U3', 'HEAD', '--'];

  const buf = execFileSync('git', args, { stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 });
  return buf.toString('utf8');
}

export interface CwdDiffResult {
  text: string;
  baseRef: string;
  headRef: string;
  // true when HEAD resolves to the base branch — branch-vs-base would be empty by
  // definition, so the diff endpoint uses this to tell the PWA to hide the toggle.
  onBaseBranch: boolean;
}

// Same as runGitDiff but for sessions that aren't backed by an outpost worktree —
// i.e. claude was launched directly inside the user's repo. Detects the current
// branch and base (main → master fallback) at call time; the worktree-manager has
// no record to lean on.
export function runGitDiffInCwd(cwd: string, mode: DiffMode): CwdDiffResult {
  const currentBranch = readCurrentBranch(cwd);
  const baseBranch = resolveBaseBranch(cwd);
  const onBaseBranch = !!currentBranch && currentBranch === baseBranch;

  if (mode === 'worktree') {
    const buf = execFileSync(
      'git',
      ['-C', cwd, 'diff', '--no-color', '--find-renames', '-U3', 'HEAD', '--'],
      { stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 },
    );
    return { text: buf.toString('utf8'), baseRef: 'HEAD', headRef: 'WORKTREE', onBaseBranch };
  }

  // branch mode — empty when there's no branch to compare against.
  if (!currentBranch || onBaseBranch) {
    return { text: '', baseRef: baseBranch, headRef: currentBranch ?? '', onBaseBranch: true };
  }
  if (!BRANCH_NAME_RE.test(currentBranch)) throw new Error(`invalid branch: ${JSON.stringify(currentBranch)}`);
  if (!BRANCH_NAME_RE.test(baseBranch)) throw new Error(`invalid baseBranch: ${JSON.stringify(baseBranch)}`);
  const buf = execFileSync(
    'git',
    ['-C', cwd, 'diff', '--no-color', '--find-renames', '-U3', `${baseBranch}...${currentBranch}`, '--'],
    { stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 },
  );
  return { text: buf.toString('utf8'), baseRef: baseBranch, headRef: currentBranch, onBaseBranch: false };
}

function readCurrentBranch(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    // 'HEAD' means detached; treat as no branch.
    return out && out !== 'HEAD' ? out : null;
  } catch { return null; }
}

function resolveBaseBranch(cwd: string): string {
  for (const ref of ['main', 'master']) {
    try {
      execFileSync('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', ref], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return ref;
    } catch { /* not present */ }
  }
  return 'main';
}

// `git worktree add` only checks out tracked files. CLAUDE.md, project-local `.claude/`,
// `.env*`, and ignored docs live outside the tree — copy them into the worktree so a
// fresh session has the same local context the user sees in the parent checkout.
// Explicit allowlist (not deny-list) to avoid dragging in node_modules/build dirs.
function isAllowlisted(rel: string): boolean {
  if (rel === 'CLAUDE.md' || rel === 'CLAUDE.local.md') return true;
  if (rel === '.claude' || rel.startsWith('.claude/')) return true;
  if (rel === 'docs' || rel.startsWith('docs/')) return true;
  // Root-level .env, .env.local, .env.production, etc. — but not nested .env files
  // inside ignored build dirs we don't want.
  if (/^\.env(\.[^/]+)?$/.test(rel)) return true;
  return false;
}

function copyAllowlistedIgnored(projectCwd: string, worktreePath: string): void {
  let output: string;
  try {
    output = execFileSync(
      'git',
      ['-C', projectCwd, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return;
  }
  for (const raw of output.split('\0')) {
    if (!raw) continue;
    // `--directory` appends a trailing slash for entirely-ignored dirs; strip it for the
    // allowlist check, then let cpSync handle the dir recursively.
    const rel = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    if (!isAllowlisted(rel)) continue;
    const src = join(projectCwd, rel);
    const dst = join(worktreePath, rel);
    if (!existsSync(src)) continue;
    try {
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst, { recursive: true, force: true, verbatimSymlinks: true });
    } catch { /* best-effort — a missing file or perm error shouldn't fail worktree creation */ }
  }
}

// Read a worktree's `.git` pointer file ("gitdir: /repo/.git/worktrees/<id>") and
// derive the parent repo's working directory. Returns null if the file is missing
// or doesn't look like a worktree pointer — caller treats that as "nothing to clean."
function readParentRepoFromGitFile(worktreePath: string): string | null {
  try {
    const contents = readFileSync(join(worktreePath, '.git'), 'utf8').trim();
    const m = contents.match(/^gitdir:\s*(.+?)\/\.git\/worktrees\/[^/]+\/?$/);
    return m ? m[1]! : null;
  } catch { return null; }
}
