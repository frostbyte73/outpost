import type { ProjectRegistry } from '../storage/project-registry.js';
import type { WorktreeManager } from './worktree-manager.js';

// Shared gate for any operation that shells out or spawns a session against a caller-supplied
// path (schedules, /api/files, ...): true only if `cwd` is a path the daemon already knows
// about — a registered project or a tracked worktree (current or archived project dir).
export function isKnownCwd(cwd: string, projectRegistry: ProjectRegistry, worktreeManager: WorktreeManager): boolean {
  if (projectRegistry.list().some((p) => p.cwd === cwd)) return true;
  for (const rec of worktreeManager.list()) {
    if (rec.worktreePath === cwd || rec.projectCwd === cwd) return true;
  }
  return false;
}
