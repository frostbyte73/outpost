import type { JobRecord, OrchestratedStep } from '../work/work-types.js';
import { handlerFor } from '../steps/index.js';

// JobTransitions are pure, side-effect-free descriptions of what the orchestrator
// should do next at the job level. The orchestrator turns them into actual writes
// (state mutation, Linear API calls). Keep this file pure — no imports from
// orchestrator, session-manager, linear-writer, etc.

export type JobTransition =
  | { kind: 'mark-done' }
  | { kind: 'mark-failed' }
  | { kind: 'mark-linear-state'; state: 'inProgress' | 'inReview' | 'done' }
  | { kind: 'link-linear-pr'; prUrl: string };

function allStepsResolved(j: JobRecord): boolean {
  if (j.steps.length === 0) return false;
  return j.steps.every((s) => handlerFor(s).isResolved(s) || s.cancelled);
}

// The id of a representative step in the earliest fully-settled parallel group
// that still has an unreviewed, non-cancelled member — or null if nothing is
// owed a review. tickOne uses this to run the orchestrator once after each group
// settles, before advancing to the next group or marking the job done. Failures
// halt the job (mark-failed) instead, so we never review over a failed plan.
export function owesStepReview(j: JobRecord): string | null {
  if (j.state !== 'executing') return null;
  if (j.reviewingStepId) return null;  // one already in flight
  if (j.steps.some((s) => !s.cancelled && s.failure)) return null;
  const steps = j.steps;
  let i = 0;
  while (i < steps.length) {
    const groupKey = steps[i]!.parallelGroup ?? `__solo_${i}`;
    let k = i;
    while (k < steps.length && (steps[k]!.parallelGroup ?? `__solo_${k}`) === groupKey) k++;
    const members = steps.slice(i, k);
    const settled = members.every((s) => s.cancelled || handlerFor(s).isResolved(s));
    if (!settled) return null;  // earlier group still running — nothing to review yet
    const unreviewed = members.find((s) => !s.cancelled && !s.reviewed);
    if (unreviewed) return unreviewed.id;
    i = k;
  }
  return null;
}

// The ticket a Linear job writes to. The hourly intake script sends only the identifier
// (`CLT-2995`), never the UUID, so the identifier has to do: LinearWriter resolves it.
export function linearIssueRef(j: JobRecord): string | undefined {
  return j.source === 'linear' ? (j.externalRef?.linearUuid ?? j.externalRef?.issueIdentifier) : undefined;
}

function linearReady(j: JobRecord): boolean {
  return !!linearIssueRef(j);
}

// The ticket moves to "in review" once every PR-bearing step actually has its PR up.
// Only orchestrated steps carry PR facts; a job of pure action steps never qualifies.
function prBearingSteps(j: JobRecord): OrchestratedStep[] {
  return j.steps.filter((s): s is OrchestratedStep => s.type === 'orchestrated' && !s.cancelled);
}

function allPrsAreRemote(steps: OrchestratedStep[]): boolean {
  return steps.every((s) => s.pr?.prState === 'open' || s.pr?.prState === 'merged');
}

// Every PR a step of this job opened goes onto the ticket as an attachment, once
// (`linearLinkedPrs` records what landed). Only writable steps: a review step's PR is
// somebody else's. Every state but abandoned, because a failed job's PR is still the ticket's
// PR, and a PR that merges on the tick that finishes the job still owes its link.
function unlinkedPrs(j: JobRecord): JobTransition[] {
  if (!linearReady(j) || j.state === 'abandoned') return [];
  const linked = new Set(j.linearLinkedPrs ?? []);
  const urls = new Set(prBearingSteps(j)
    .filter((s) => s.workspace.kind === 'writable')
    .map((s) => s.pr?.prUrl)
    .filter((u): u is string => !!u && !linked.has(u)));
  return [...urls].map((prUrl) => ({ kind: 'link-linear-pr', prUrl }));
}

// Pure decision: given a job record, what job-level transitions are needed?
// Caller is responsible for executing them in order. Returning multiple
// transitions in one call is fine — they don't conflict (e.g. you can mark a
// job done AND mark Linear done in the same tick).
export function decideJobTransitions(j: JobRecord): JobTransition[] {
  return [...stateTransitions(j), ...unlinkedPrs(j)];
}

function stateTransitions(j: JobRecord): JobTransition[] {
  if (j.state === 'failed' || j.state === 'abandoned') return [];

  // An already-done job still owes Linear its done-write if the write hasn't landed:
  // mark-done is emitted before mark-linear-state in the same batch below, so a throw
  // on the Linear call leaves a done job whose ticket never moved. Re-emitting here is
  // what makes the orchestrator's retry-next-tick reachable at all.
  if (j.state === 'done') {
    return linearReady(j) && !j.linearStateMarked?.done
      ? [{ kind: 'mark-linear-state', state: 'done' }]
      : [];
  }

  const out: JobTransition[] = [];

  // A failed step halts the plan: never advance to later steps. Settle the job into
  // the terminal `failed` state so the halt is surfaced (not silently stuck in
  // `executing`). onStepRetry/rerunLatest restore it to `executing` on retry.
  if (j.state === 'executing' && j.steps.some((s) => !s.cancelled && s.failure)) {
    return [{ kind: 'mark-failed' }];
  }

  if (j.state === 'executing' && allStepsResolved(j)) {
    out.push({ kind: 'mark-done' });
    if (linearReady(j) && !j.linearStateMarked?.done) {
      out.push({ kind: 'mark-linear-state', state: 'done' });
    }
    return out;  // terminal — don't double-emit inProgress/inReview when also marking done
  }

  if (j.state === 'executing' && linearReady(j)) {
    if (!j.linearStateMarked?.inProgress) {
      out.push({ kind: 'mark-linear-state', state: 'inProgress' });
    }
    const prSteps = prBearingSteps(j);
    if (!j.linearStateMarked?.inReview && prSteps.length > 0 && allPrsAreRemote(prSteps)) {
      out.push({ kind: 'mark-linear-state', state: 'inReview' });
    }
  }

  return out;
}
