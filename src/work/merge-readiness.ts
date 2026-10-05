import type { RunGh } from '../integrations/gh-cli.js';
import { checkStateOf, normalizeLogin, type GhCheckRollup } from '../integrations/pr-watcher.js';
import type { PrComment } from './work-types.js';

export interface PrSnapshot {
  reviewDecision?: string | null;
  mergeable?: string;
  headRefOid?: string;
  statusCheckRollup?: GhCheckRollup[];
}

export function mergeBlocker(snap: PrSnapshot, sha: string, unanswered: number): string | undefined {
  if (snap.reviewDecision !== 'APPROVED') return `review is ${snap.reviewDecision ?? 'not approved'}`;
  const states = (snap.statusCheckRollup ?? []).map(checkStateOf);
  if (!states.length) return 'no checks have reported';
  if (states.includes('failure')) return 'a check failed';
  if (states.includes('pending')) return 'a check is still running';
  if (snap.mergeable !== 'MERGEABLE') return `PR is not mergeable (${snap.mergeable ?? 'unknown'})`;
  if (snap.headRefOid !== sha) return `head moved to ${snap.headRefOid?.slice(0, 7) ?? 'unknown'}`;
  if (unanswered > 0) return `${unanswered} unanswered comment${unanswered === 1 ? '' : 's'}`;
  return undefined;
}

// An unknown viewer counts our own roots too: failing open would merge over an unanswered thread.
export function unansweredCount(comments: PrComment[] | undefined, viewer: string | undefined): number {
  return (comments ?? []).filter((c) => !c.inReplyTo && !c.respondedAt
    && (viewer === undefined || normalizeLogin(c.author) !== viewer)).length;
}

export async function readMergeReadiness(
  runGh: RunGh, cwd: string, prNumber: number, sha: string, comments: PrComment[] | undefined,
): Promise<string | undefined> {
  const snap = JSON.parse(await runGh(cwd, [
    'pr', 'view', String(prNumber), '--json', 'reviewDecision,mergeable,headRefOid,statusCheckRollup',
  ])) as PrSnapshot;
  let viewer: string | undefined;
  try {
    const login = (JSON.parse(await runGh(cwd, ['api', 'user'])) as { login?: string }).login;
    viewer = login ? normalizeLogin(login) : undefined;
  } catch {
    viewer = undefined;
  }
  return mergeBlocker(snap, sha, unansweredCount(comments, viewer));
}
