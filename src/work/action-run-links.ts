import type { RunLink } from '../storage/action-runs-store.js';
import type { JobRecord, OrchestratedStep } from './work-types.js';

// Code rounds leave no draft to diff; what happened to their code afterwards is the answer key.
export const CODE_ROUND_ACTIONS: ReadonlySet<string> = new Set(['code.implement', 'code.fix-ci', 'code.fix-pr-comment']);

export interface LinkEvent { stepId: string; link: RunLink; all?: boolean }

function stepLinks(p: OrchestratedStep, n: OrchestratedStep, at: number): LinkEvent[] {
  const out: LinkEvent[] = [];
  const add = (link: RunLink, all?: boolean) => out.push({ stepId: n.id, link, ...(all ? { all } : {}) });
  if (n.pr?.ciState === 'failure' && p.pr?.ciState !== 'failure') {
    add({ kind: 'ciFailed', at, ...(n.pr.headRefOid ? { headSha: n.pr.headRefOid } : {}) });
  }
  const seen = new Set((p.pr?.comments ?? []).map((c) => c.id));
  const fresh = (n.pr?.comments ?? []).filter((c) => !seen.has(c.id));
  if (fresh.length) add({ kind: 'prComments', at, comments: fresh.map((c) => ({ id: c.id, author: c.author })) });
  const review = n.artifacts?.review;
  if (review && review !== p.artifacts?.review) add({ kind: 'reviewFindings', at, ref: review });
  if (n.pr?.prState === 'merged' && p.pr?.prState !== 'merged' && n.pr.prUrl) {
    add({ kind: 'merged', at, prUrl: n.pr.prUrl }, true);
  }
  return out;
}

export function deriveLinkEvents(prev: JobRecord | undefined, next: JobRecord, now: number): LinkEvent[] {
  if (!prev) return [];
  const before = new Map(prev.steps.map((s) => [s.id, s]));
  return next.steps.flatMap((n) => {
    const p = before.get(n.id);
    return p?.type === 'orchestrated' && n.type === 'orchestrated' ? stepLinks(p, n, now) : [];
  });
}
