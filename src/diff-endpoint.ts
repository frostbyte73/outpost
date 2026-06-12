import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { WorktreeManager } from './worktree-manager.js';
import { runGitDiff, runGitDiffInCwd } from './worktree-manager.js';
import { parseUnifiedDiff, type DiffFile } from './diff-parser.js';

const MAX_FILES = 50;

export type DiffMode = 'branch' | 'worktree';

// Minimal duck-typed shape; SessionStore satisfies it but tests can pass a stub.
export interface SessionLookup {
  findSession(id: string): { cwd: string } | null;
}

export type DiffResponse =
  | { status: 200; body: {
      mode: DiffMode;
      baseRef: string;
      headRef: string;
      files: DiffFile[];
      truncated?: { hiddenFiles: number };
      // Present when HEAD == base branch. The PWA hides the branch-vs-base toggle in
      // that case — branch mode is meaningless and worktree mode is the only useful view.
      onBaseBranch?: boolean;
    } }
  | { status: 400 | 404; body: { error: string } };

export function handleDiffRoute(
  wm: WorktreeManager,
  sessionLookup: SessionLookup,
  sessionId: string,
  mode: string,
): DiffResponse {
  if (mode !== 'branch' && mode !== 'worktree') {
    return { status: 400, body: { error: 'invalid mode' } };
  }
  const m: DiffMode = mode;

  // Path 1: outpost-managed worktree session. Keep the existing semantics —
  // branch mode diffs against the stored baseBranch on the parent repo's checkout,
  // worktree mode diffs uncommitted changes inside the worktree itself.
  const rec = wm.get(sessionId);
  if (rec && rec.archivedAt) {
    return { status: 404, body: { error: 'session is archived' } };
  }
  if (rec && rec.worktreePath) {
    const text = runGitDiff(rec, m);
    const allFiles = parseUnifiedDiff(text);
    const baseBranch = rec.baseBranch && rec.baseBranch.length > 0 ? rec.baseBranch : 'main';
    return buildResponse(m, allFiles, {
      baseRef: m === 'branch' ? baseBranch : 'HEAD',
      headRef: m === 'branch' ? rec.branch : 'WORKTREE',
    });
  }

  // Path 2: session running directly in a user repo, no worktree. Resolve the cwd
  // from the session store; the current branch + base are detected at call time.
  const found = sessionLookup.findSession(sessionId);
  if (!found) return { status: 404, body: { error: 'no such session' } };
  if (!isGitRepoSync(found.cwd)) {
    return { status: 404, body: { error: 'session cwd is not a git repo' } };
  }
  const result = runGitDiffInCwd(found.cwd, m);
  const allFiles = parseUnifiedDiff(result.text);
  return buildResponse(m, allFiles, {
    baseRef: result.baseRef,
    headRef: result.headRef,
    onBaseBranch: result.onBaseBranch,
  });
}

function buildResponse(
  mode: DiffMode,
  allFiles: DiffFile[],
  extra: { baseRef: string; headRef: string; onBaseBranch?: boolean },
): DiffResponse {
  const files = allFiles.slice(0, MAX_FILES);
  const body = {
    mode,
    baseRef: extra.baseRef,
    headRef: extra.headRef,
    files,
    ...(allFiles.length > MAX_FILES ? { truncated: { hiddenFiles: allFiles.length - MAX_FILES } } : {}),
    ...(extra.onBaseBranch ? { onBaseBranch: true } : {}),
  };
  return { status: 200, body };
}

// `.git` is a directory in normal checkouts and a file in git worktrees / submodules —
// accept either.
function isGitRepoSync(cwd: string): boolean {
  try {
    const st = statSync(join(cwd, '.git'));
    return st.isDirectory() || st.isFile();
  } catch { return false; }
}
