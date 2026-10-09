import { execFileSync } from 'node:child_process';
import { repoFromRemoteUrl } from './worktree-manager.js';

// A GitHub login, or an `org/team` slug. No leading `-`: these land in gh's argv.
const ENTRY_RE = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

export function isReviewerEntry(v: unknown): v is string {
  return typeof v === 'string' && ENTRY_RE.test(v);
}

// A team exists only inside its own org, and requesting one anywhere else fails `gh pr create`
export function reviewersForRepo(entries: string[], repo: string | null): string[] {
  const owner = repo?.split('/')[0]?.toLowerCase();
  return entries.filter((e) => {
    const slash = e.indexOf('/');
    return slash === -1 || e.slice(0, slash).toLowerCase() === owner;
  });
}

// Reviewers to request on a PR opened from `cwd`, scoped by its origin's owner
export function reviewersForCwd(entries: string[], cwd: string): string[] {
  if (!entries.length) return [];
  let repo: string | null = null;
  try {
    repo = repoFromRemoteUrl(execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch { /* no origin: only plain logins apply */ }
  return reviewersForRepo(entries, repo);
}
