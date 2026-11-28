import { execFileSync } from 'node:child_process';
import type { WorkspaceRef } from './work-types.js';

// A step's workspace is authored outside the daemon — by a planner via submit_plan, or by the
// plan editor — so it needs checking where it enters. A `readonly`/`writable` ref missing
// repoCwd materializes fine and then fails at provision time, which is a dead end: the step
// can only be dropped and re-added, since retrying re-provisions the same broken ref.
export function workspaceError(ws: WorkspaceRef | undefined): string | null {
  if (ws === undefined) return null;
  if (!ws || typeof ws !== 'object') return 'workspace must be an object';
  const kind = (ws as { kind?: unknown }).kind;
  if (kind === 'none') return null;
  if (kind !== 'readonly' && kind !== 'writable') {
    return `unknown workspace.kind ${JSON.stringify(kind)} — expected "none", "readonly" or "writable"`;
  }
  const repoCwd = (ws as { repoCwd?: unknown }).repoCwd;
  if (typeof repoCwd !== 'string' || !repoCwd.trim()) {
    return `workspace.${kind} requires repoCwd (absolute path to the repo) — use {"kind":"none"} for work that needs no checkout of its own`;
  }
  if (kind === 'writable') {
    const branch = (ws as { branch?: unknown }).branch;
    if (typeof branch !== 'string' || !branch.trim()) return 'workspace.writable requires branch';
    return branchPathConflict(repoCwd, branch);
  }
  return null;
}

// `refactor` and `refactor/x` can't coexist as refs, locally or on origin — only a rename gets past it
function branchPathConflict(repoCwd: string, branch: string): string | null {
  const parts = branch.split('/');
  let refs: string[];
  try {
    refs = execFileSync(
      'git',
      ['-C', repoCwd, 'for-each-ref', '--format=%(refname)', `refs/heads/${parts[0]}`, `refs/remotes/origin/${parts[0]}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).split('\n').filter(Boolean);
  } catch { return null; }
  const prefixes = new Set(parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/')));
  for (const ref of refs) {
    const name = ref.replace(/^refs\/(heads|remotes\/origin)\//, '');
    if (prefixes.has(name) || name.startsWith(`${branch}/`)) {
      return `workspace.writable branch ${JSON.stringify(branch)} collides with existing ref ${JSON.stringify(ref)} in ${repoCwd} — `
        + 'git stores branches as paths, so one can\'t be a directory of the other. Pick a different branch name';
    }
  }
  return null;
}

// A meta.session must never own a branch: its session is the user's, and a writable worktree
// would claim the branch from the step that ships it.
export function sessionWorkspaceError(action: string | undefined, ws: WorkspaceRef | undefined): string | null {
  if (action === 'meta.session' && ws?.kind === 'writable') {
    return `${action} takes a "readonly" or "none" workspace, never "writable"`;
  }
  return null;
}

// A child session must never inherit a writable ref from its parent. Two worktrees can't hold
// one branch: WorktreeManager.create() resolves that collision by `git worktree move`-ing the
// existing checkout — the parent's own live worktree — into the child's slot, leaving the
// parent's recorded path and its session cwd pointing at nothing. Detaching at the same branch
// gives the child the identical tree to read at its own path, with no claim on the branch.
export function readonlyView(ws: WorkspaceRef): WorkspaceRef {
  if (ws.kind !== 'writable') return ws;
  return { kind: 'readonly', repoCwd: ws.repoCwd, ref: ws.branch };
}
