import type { JobRecord, OrchestratedStep, Step } from './work-types.js';
import { actionNameForStep } from './engine.js';
import type { ActionRunOutcome } from '../storage/action-runs-store.js';
import { sameRaiser, type WriteDraft } from './write-draft.js';

// Derives per-action run boundaries by diffing two consecutive JobRecord snapshots.
//
// The engine already answers "which action is running on this step right now" —
// actionNameForStep, a pure function of step state. The attribution the run ledger
// needs was never a missing field, only a missing *sample*: evaluate it once per
// mutation instead of once at read time and the whole round history falls out. So
// this module is the only place round semantics live, and the engine stays untouched.
//
// Emission order within a unit is load-bearing: close → verdict → open. acceptDraft and
// reviseDraft mutate the step's pending draft and flip it back to `running` in a single
// mutateStep call, so a verdict emitted after the open would land on the wrong attempt.
//
// Controller rounds are derived here too. They weren't at first, and the gap was invisible in
// a way that mattered: `selectActionToImprove` elects on run counts and scores on run
// outcomes, so the thirteen actions that only ever run bound to a controller had no rows, no
// score, and no route into the improvement loop except a recurring permission denial. What is
// still uncovered is a DISPATCH — a child action session fanned out from a controller. The
// ledger keys an open run by `jobId:stepId`, and sibling dispatches run concurrently under one
// stepId, so covering them needs a key that admits the dispatch id, not another round rule.

export interface RunKey { jobId: string; stepId?: string }

export type RunEvent =
  | { t: 'open'; key: RunKey; action: string; round: string; sessionId?: string; at: number }
  | { t: 'close'; key: RunKey; outcome: ActionRunOutcome; at: number; failureReason?: string }
  | { t: 'verdict'; key: RunKey; round?: string; outcome: ActionRunOutcome; at: number; feedbackChars?: number };

export interface DeriveOpts {
  now: number;
}

// A step is no longer gated by frontmatter — it's gated by whether it actually raised a
// draft. At most one draft is ever unresolved per raiser (see StepBase.drafts). For an
// orchestrated step only the CONTROLLER's own draft belongs to this round: a dispatch-raised
// draft never parks the parent step, so counting it would split a round that never stopped.
function pendingDraft(s: Step): WriteDraft | undefined {
  return (s.drafts ?? []).find((d) =>
    !d.approvedAt && (s.type !== 'orchestrated' || d.raisedBy.kind === 'controller'));
}

function hasApprovedDraft(s: Step): boolean {
  return s.type === 'action' && !!s.drafts?.some((d) => d.approvedAt);
}

// `actionNameForStep` answers `controller`, which is fixed for the step's whole life and never
// reflects a self-round's rebind — so every bound sub-action round would be filed under the
// controller, which is exactly why `code.reply-pr-comments` and its twelve peers had no run
// rows at all. This is the identity the session actually ran as (engine.actionForStep agrees).
function boundActionOf(s: OrchestratedStep): string {
  return s.boundAction ?? s.controller;
}

function runActionOf(s: Step): string {
  return s.type === 'orchestrated' ? boundActionOf(s) : actionNameForStep(s);
}

// The round key a pending draft puts the step in. An ActionStep's is bare — its round IS the
// draft. A controller's carries the action bound for that round, so the gate lands on the row
// for the sub-action that raised it rather than on whatever ran before it.
function draftRound(s: Step, d: WriteDraft): string {
  const phase = (d.feedback ?? []).length > 0 ? 'redraft' : 'draft';
  return s.type === 'orchestrated' ? `${boundActionOf(s)}#${phase}` : phase;
}

// Round in flight for a step, or null when nothing is dispatched. A pending draft counts
// whether the step is actively drafting/redrafting (`running`) or parked waiting on the
// user (`gate_pending_approval`) — both are the same round. `gate_pending_approval` with
// no pending draft is the instant between denyDraft dropping the draft and declineStep
// landing the terminal `declined` state (or, on a controller, a voluntary `gate` move);
// that's not a live round, so it returns null rather than falling through to `run`.
//
// A controller round is keyed on its bound action ALONE, deliberately not on `roundsSpent`:
// the two move at different mutations — `roundsSpent` increments when the controller reports
// its move, `boundAction` only when the next round actually launches — so a composite key
// would open a phantom row for the outgoing action on every round. The cost is that
// consecutive rounds bound to the same action collapse into one row, which lands on the
// controller's own back-to-back decision turns; a sub-action rebinds away after its round, so
// the rows this exists to produce are unaffected. `waiting` is a yield and closes the round.
function roundOf(s: Step): string | null {
  if (s.cancelled || s.failure || !s.sessionId) return null;
  const pending = pendingDraft(s);
  if (s.state === 'gate_pending_approval') return pending ? draftRound(s, pending) : null;
  if (s.state !== 'running') return null;
  if (pending) return draftRound(s, pending);
  return s.type === 'orchestrated' ? boundActionOf(s) : hasApprovedDraft(s) ? 'commit' : 'run';
}

// An orchestrator round is in flight while the job is parked in `planning` (initial /
// replan) or while a step-review holds the gate — a review runs on top of `executing`,
// so the state alone can't see it.
function orchestratorRound(j: JobRecord): string | null {
  if (!j.orchestratorSessionId) return null;
  if (j.state !== 'planning' && !j.reviewingStepId) return null;
  const started = [...(j.events ?? [])].reverse().find((e) => e.kind === 'orchestrator_started');
  return started?.body ?? 'initial';
}

// `submitted` means a verdict is still owed — by a user gate. Rounds that reach a
// terminal state with nobody left to rule on them are scored here and never sit pending.
// Read off the phase suffix, since a controller's draft round carries its bound action as a
// prefix and everything else (`run`, `commit`, a bare bound action) has no suffix at all.
function closeOutcome(round: string): ActionRunOutcome {
  const phase = round.slice(round.indexOf('#') + 1);
  return phase === 'draft' || phase === 'redraft' ? 'submitted' : 'accepted';
}

function stepEvents(prev: Step | undefined, next: Step | undefined, jobId: string, job: JobRecord, prevJob: JobRecord | undefined, opts: DeriveOpts): RunEvent[] {
  const out: RunEvent[] = [];
  const key: RunKey = { jobId, stepId: (next ?? prev)!.id };
  const prevRound = prev ? roundOf(prev) : null;
  const nextRound = next ? roundOf(next) : null;
  const at = opts.now;

  if (prevRound && prevRound !== nextRound) {
    if (!next) {
      out.push({ t: 'close', key, outcome: 'abandoned', at });
    } else if (next.failure && !prev!.failure) {
      out.push({ t: 'close', key, outcome: 'failed', at, failureReason: next.failure.reason });
    } else if ((next.cancelled && !prev!.cancelled) || (job.state === 'abandoned' && prevJob?.state !== 'abandoned')) {
      out.push({ t: 'close', key, outcome: 'abandoned', at });
    } else {
      out.push({ t: 'close', key, outcome: closeOutcome(prevRound), at });
    }
  }

  if (prev && next) out.push(...verdictEvents(key, prev, next, at));

  if (nextRound && nextRound !== prevRound) {
    out.push({ t: 'open', key, action: runActionOf(next!), round: nextRound, sessionId: next!.sessionId, at });
  }
  return out;
}

// Every draft raised by the same raiser as `raisedBy` — submitDraft's own carry-forward
// invariant is "at most one unresolved" per raiser, but approved drafts from earlier,
// already-decided rounds are kept around forever (see StepBase.drafts), so there can be more
// than one match once a step has made two or more gated writes.
function draftsForRaiser(s: Step, raisedBy: WriteDraft['raisedBy']): WriteDraft[] {
  return (s.drafts ?? []).filter((d) => sameRaiser(d.raisedBy, raisedBy));
}

// Compares the draft prev was waiting on against what next did with it: approved (accepted),
// still pending with more feedback than before (revised), still pending with the same
// feedback (a bare resubmission mid-round — nothing to verdict yet), or gone without ever
// being approved (denied — the user ruled the write shouldn't happen at all).
//
// Correlated by RAISER, not by draft id: a resubmission after a revise mints a fresh id
// (carrying feedback forward), so id-matching would misread it as a denial. And "approved"
// has to mean *newly* approved for this raiser — `next` can already carry an older, unrelated
// approved draft from a prior round for the same raiser (a step making two gated writes), and
// checking "any approved draft exists" would misscore denying the second write as accepted.
function verdictEvents(key: RunKey, prev: Step, next: Step, at: number): RunEvent[] {
  const p = pendingDraft(prev);
  if (!p) return [];
  // A retry (or, in principle, any other path that wipes `drafts` outright without a verdict)
  // clears the session along with it — that's an abandoned round, not a decision; the close
  // path already scores it, so don't also fabricate a verdict here.
  if (!next.sessionId) return [];
  // The round key `prev` was actually open under — not `draftRound(prev, p)` directly, so a
  // step whose round was never opened (cancelled, failed) can't patch a verdict onto some
  // older row that happens to share the name.
  const round = roundOf(prev);
  if (!round) return [];
  const forRaiserNext = draftsForRaiser(next, p.raisedBy);
  const pending = forRaiserNext.find((d) => !d.approvedAt);
  if (pending) {
    const prevNotes = (p.feedback ?? []).length;
    const nextNotes = (pending.feedback ?? []).length;
    if (nextNotes <= prevNotes) return [];
    const note = pending.feedback!.at(-1) ?? '';
    return [{ t: 'verdict', key, round, outcome: 'revised', at, feedbackChars: note.length }];
  }
  const approvedBefore = new Set(draftsForRaiser(prev, p.raisedBy).filter((d) => d.approvedAt).map((d) => d.id));
  const newlyApproved = forRaiserNext.some((d) => d.approvedAt && !approvedBefore.has(d.id));
  return [{ t: 'verdict', key, round, outcome: newlyApproved ? 'accepted' : 'denied', at }];
}

function orchestratorEvents(prev: JobRecord | undefined, next: JobRecord, opts: DeriveOpts): RunEvent[] {
  const out: RunEvent[] = [];
  const key: RunKey = { jobId: next.id };
  const prevRound = prev ? orchestratorRound(prev) : null;
  const nextRound = orchestratorRound(next);
  const at = opts.now;

  if (prevRound && prevRound !== nextRound) {
    const outcome: ActionRunOutcome = next.state === 'executing' ? 'accepted'
      : next.state === 'abandoned' ? 'abandoned'
      : next.state === 'failed' ? 'failed'
      : 'submitted';
    out.push({ t: 'close', key, outcome, at });
  }

  if (prev?.state === 'plan_pending_review' && next.state === 'executing') {
    out.push({ t: 'verdict', key, outcome: 'accepted', at });
  }
  const rejectedGrew = (next.plan?.iterationsRejected ?? []).length - (prev?.plan?.iterationsRejected ?? []).length;
  if (rejectedGrew > 0) {
    const note = (next.plan?.iterationsRejected ?? []).at(-1)?.feedback ?? '';
    out.push({ t: 'verdict', key, outcome: 'revised', at, feedbackChars: note.length });
  }

  if (nextRound && nextRound !== prevRound) {
    out.push({
      t: 'open', key, round: nextRound, at,
      action: next.orchestratorAction ?? 'meta.orchestrate',
      sessionId: next.orchestratorSessionId,
    });
  }
  return out;
}

export function deriveRunEvents(prev: JobRecord | undefined, next: JobRecord, opts: DeriveOpts): RunEvent[] {
  const out = orchestratorEvents(prev, next, opts);
  const prevSteps = new Map((prev?.steps ?? []).map((s) => [s.id, s]));
  for (const s of next.steps) {
    out.push(...stepEvents(prevSteps.get(s.id), s, next.id, next, prev, opts));
    prevSteps.delete(s.id);
  }
  for (const gone of prevSteps.values()) {
    out.push(...stepEvents(gone, undefined, next.id, next, prev, opts));
  }
  return out;
}
