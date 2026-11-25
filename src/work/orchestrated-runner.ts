import { validateNext, type ActionInfo } from '../steps/orchestrated-policy.js';
import {
  coalesceExternal, deliverImmediate, drainForDelivery, externalHoldUntil, shouldDeliver,
} from '../steps/orchestrated-inbox.js';
import type { Dispatch, InboxItem, NextMove, OrchestratedStep, WatchedEvent } from './work-types.js';
import type { EffectivePreapprovals } from './preapprovals.js';

type UpdateRound = (step: OrchestratedStep) => OrchestratedStep;

export interface OrchestratedHost {
  getStep(jobId: string, stepId: string): OrchestratedStep | undefined;
  mutateStep(jobId: string, stepId: string, fn: (s: OrchestratedStep) => OrchestratedStep): void;
  sessionWorking(sessionId: string): boolean;
  // Resume the controller's own session. `action` rebinds its allowlist for a work turn;
  // undefined means it keeps the controller's own grant.
  resumeController(jobId: string, stepId: string, action: string | undefined, note: string | undefined, selected?: string): void;
  spawnDispatch(jobId: string, stepId: string, dispatch: Dispatch): void;
  resolveStep(jobId: string, stepId: string, output: string, update?: UpdateRound): void;
  failStep(jobId: string, stepId: string, reason: string, update?: UpdateRound): void;
  // Re-run delivery for this step at `at` (epoch ms). The only thing that ever un-holds a batch
  // parked by the external quiet period: nothing else is guaranteed to come along, since the
  // watcher pushes only when a signal moves and a quiet PR moves nothing. Idempotent per step —
  // a later call replaces an earlier one.
  scheduleDelivery(jobId: string, stepId: string, at: number): void;
  actionInfo: ActionInfo;
  runtimeRefusal?(jobId: string, stepId: string, action: string, via: 'self-round' | 'dispatch'): string | undefined;
  preapprovalsFor(jobId: string, stepId: string): EffectivePreapprovals;
  newId(): string;
  now(): number;
}

export interface ProgressPayload {
  memo?: string;
  artifacts?: Record<string, string>;
  phase?: string;
  next: NextMove;
}

// An inbox item before the daemon stamps id/at onto it.
export type NewItem =
  | { kind: 'user-message'; body: string }
  | { kind: 'dispatch-done'; dispatchId: string }
  | { kind: 'external'; source: 'pr-watcher'; summary: string; events: WatchedEvent[] }
  | { kind: 'gate-resolved'; approved: boolean; feedback?: string }
  | { kind: 'timer' }
  | { kind: 'policy-rejection'; reason: string };

function stamp(host: OrchestratedHost, item: NewItem): InboxItem {
  return { id: host.newId(), at: host.now(), ...item } as InboxItem;
}

function recordProgress(s: OrchestratedStep, p: ProgressPayload): OrchestratedStep {
  const specChanged = p.artifacts?.spec !== undefined && p.artifacts.spec !== s.artifacts?.spec;
  // Merge, don't replace: one round must not clobber an earlier round's artifact.
  const artifacts = p.artifacts ? { ...(s.artifacts ?? {}), ...p.artifacts } : s.artifacts;
  // A plan written against the old spec would skip the new spec's gate and plan round
  if (specChanged && artifacts && p.artifacts?.implPlan === undefined) delete artifacts.implPlan;
  return {
    ...s,
    ...(p.memo !== undefined ? { memo: p.memo } : {}),
    ...(p.phase !== undefined ? { phase: p.phase } : {}),
    ...(p.artifacts ? { artifacts } : {}),
    ...(specChanged ? { specApprovedAt: undefined } : {}),
  };
}

// Did this round have anything to show for itself? Must be answered against the step as it
// stood BEFORE recordProgress folded the payload in — afterwards the payload's phase and
// artifacts are already stored and every round looks unchanged.
// Content, not keys: redrafting `artifacts.spec` to address a declined gate reuses the key and
// is plainly real work. Only a byte-identical resubmit says the round produced nothing.
function isProductive(before: OrchestratedStep, p: ProgressPayload): boolean {
  if (p.phase !== undefined && p.phase !== before.phase) return true;
  const had = before.artifacts ?? {};
  return Object.entries(p.artifacts ?? {}).some(([k, v]) => had[k] !== v);
}

export function applyMove(host: OrchestratedHost, jobId: string, stepId: string, p: ProgressPayload): void {
  const step = host.getStep(jobId, stepId);
  // A controller's turn can outlive the step: mark-resolved (or any other force-settle) can
  // land while a round is in flight, and its submit_step_progress call arrives after. Without
  // this guard, the reject branch below runs deliverImmediate — which sets state back to
  // 'running' — and resumes the controller, resurrecting a step the user just closed out.
  // `.failure` is checked too, not just `state === 'failed'` — some failure paths land
  // `.failure` without (yet) updating `state`, and this must hold even then.
  if (!step || step.state === 'resolved' || step.state === 'failed' || step.failure) return;
  // A step parked at a gate is the user's turn. Running a second move here would flip state
  // back to 'running' and strand `step.gate`, which resolveGate then refuses to touch — the
  // user's Approve becomes a silent no-op.
  if (step.state === 'gate_pending_approval') return;
  const productive = isProductive(step, p);
  const progress = recordProgress(step, p);

  const info: ActionInfo = {
    ...host.actionInfo,
    runtimeRefusal: (action, via) => host.runtimeRefusal?.(jobId, stepId, action, via),
  };
  const verdict = validateNext(progress, p.next, info, productive, host.preapprovalsFor(jobId, stepId));

  if (verdict.kind === 'reject') {
    // One corrective turn. A controller that violates policy twice running (with no accepted
    // move in between to earn forgiveness — see runMove) is not going to recover on a third try.
    if (step.pendingPolicyStrike) {
      host.failStep(jobId, stepId, `controller violated policy twice: ${verdict.reason}`,
        (s) => ({ ...recordProgress(s, p), pendingRound: undefined }));
      return;
    }
    const item = stamp(host, { kind: 'policy-rejection', reason: verdict.reason });
    const round = { id: host.newId(), action: step.controller, delivered: [item] };
    host.mutateStep(jobId, stepId, (s) => {
      const updated = recordProgress(s, p);
      return { ...deliverImmediate({ ...updated, inbox: [...s.inbox, item] }, [item]), pendingPolicyStrike: true, pendingRound: round };
    });
    host.resumeController(jobId, stepId, undefined, undefined, round.id);
    return;
  }

  runMove(host, jobId, stepId, verdict.move, productive, (s) => ({
    ...recordProgress(s, p), roundsSpent: s.roundsSpent + 1, pendingRound: undefined, pendingPolicyStrike: false,
  }));
}

function openGate(
  host: OrchestratedHost, jobId: string, stepId: string,
  gate: { draft: string; question: string }, update: UpdateRound,
): void {
  host.mutateStep(jobId, stepId, (s) => ({
    ...update(s),
    state: 'gate_pending_approval',
    gate: { ...gate, requestedAt: host.now() },
    // A fresh gate is an unanswered question — clear any verdict left over from a prior one,
    // or a controller reading gateApproved while this gate is still pending (or after it's
    // declined) would see stale approval from an earlier round.
    gateApproved: undefined,
    // A gated move is a move policy accepted, so it earns the same forgiveness runMove grants —
    // otherwise a strike survives a legitimate move and the next rejection fails the step.
    pendingPolicyStrike: false,
    // A gate is the strongest yield there is — the step parks and a human decides — so it
    // forgives the self-round budget at least as much as a dispatch or a wait does.
    consecutiveSelfRounds: 0,
  }));
}

function runMove(host: OrchestratedHost, jobId: string, stepId: string, move: NextMove, productive: boolean, update: UpdateRound): void {
  switch (move.kind) {
    case 'self-round': {
      const step = host.getStep(jobId, stepId)!;
      const round = { id: host.newId(), action: move.action ?? step.controller, note: move.note, delivered: step.lastDelivered };
      host.mutateStep(jobId, stepId, (s) => ({
        ...update(s), state: 'running', waitingOn: undefined, pendingRound: round,
        consecutiveSelfRounds: productive ? 0 : s.consecutiveSelfRounds + 1,
      }));
      host.resumeController(jobId, stepId, move.action, move.note, round.id);
      return;
    }

    case 'dispatch': {
      const priorDispatches = host.getStep(jobId, stepId)!.dispatches;
      const created: Dispatch[] = move.dispatches.map((d) => {
        const prior = d.retryOf ? priorDispatches.find((x) => x.id === d.retryOf) : undefined;
        return {
          id: host.newId(),
          action: d.action,
          brief: d.brief,
          ...(d.inputs ? { inputs: d.inputs } : {}),
          ...(d.workspace ? { workspace: d.workspace } : {}),
          ...(d.retryOf ? { retryOf: d.retryOf } : {}),
          status: 'queued',
          attempts: (prior?.attempts ?? 0) + 1,
        };
      });
      host.mutateStep(jobId, stepId, (s) => ({
        ...update(s),
        dispatches: [...s.dispatches, ...created],
        state: 'waiting',
        consecutiveSelfRounds: 0,
        waitingOn: {
          reason: `Running ${created.map((d) => d.action).join(', ')}`,
          untilAllDispatchesDone: true,
        },
      }));
      for (const d of created) host.spawnDispatch(jobId, stepId, d);
      return;
    }

    case 'wait':
      host.mutateStep(jobId, stepId, (s) => ({
        ...update(s), state: 'waiting', waitingOn: move.wait, consecutiveSelfRounds: 0,
      }));
      return;

    case 'gate':
      openGate(host, jobId, stepId, { draft: move.draft, question: move.question }, update);
      return;

    case 'resolve':
      host.resolveStep(jobId, stepId, move.output, update);
      return;

    case 'fail':
      host.failStep(jobId, stepId, move.reason, update);
      return;
  }
}

export function resolveGate(
  host: OrchestratedHost, jobId: string, stepId: string, approved: boolean, feedback?: string,
): void {
  const step = host.getStep(jobId, stepId);
  if (!step || step.state !== 'gate_pending_approval') return;
  const item = stamp(host, { kind: 'gate-resolved', approved, ...(feedback ? { feedback } : {}) });
  const round = { id: host.newId(), action: step.controller, delivered: [item] };

  host.mutateStep(jobId, stepId, (s) => ({
    ...deliverImmediate({ ...s, inbox: [...s.inbox, item] }, [item]),
    gate: undefined,
    // Durable answers to the voluntary gate: decline's reason survives in gateFeedback,
    // approve's yes survives in gateApproved — both outlive the transient gate-resolved
    // item below, which the next inbox delivery overwrites in lastDelivered.
    ...(approved ? { gateApproved: true } : {}),
    ...(approved && s.artifacts?.spec && !s.artifacts?.implPlan ? { specApprovedAt: host.now() } : {}),
    ...(feedback ? { gateFeedback: [...(s.gateFeedback ?? []), feedback] } : {}),
    pendingRound: round,
  }));
  host.resumeController(jobId, stepId, undefined, undefined, round.id);
}

export function pushInbox(host: OrchestratedHost, jobId: string, stepId: string, item: NewItem): void {
  const step = host.getStep(jobId, stepId);
  if (!step) return;
  host.mutateStep(jobId, stepId, (s) => ({ ...s, inbox: coalesceExternal(s.inbox, stamp(host, item)) }));
  deliverInbox(host, jobId, stepId);
}

export function deliverInbox(host: OrchestratedHost, jobId: string, stepId: string): void {
  let step = host.getStep(jobId, stepId);
  if (!step) return;
  // A pure timed soak has an empty inbox by construction, and shouldDeliver refuses to deliver
  // an empty one — so the wake has to materialize the item it delivers. This is the producer of
  // the `timer` InboxItem, and the only reason a `wait` carrying just `resumeAt` can ever fire.
  if (step.inbox.length === 0 && step.state === 'waiting'
      && step.waitingOn?.resumeAt !== undefined && host.now() >= step.waitingOn.resumeAt) {
    host.mutateStep(jobId, stepId, (s) => ({ ...s, inbox: [...s.inbox, stamp(host, { kind: 'timer' })] }));
    step = host.getStep(jobId, stepId)!;
  }
  const working = step.sessionId ? host.sessionWorking(step.sessionId) : false;
  if (!shouldDeliver(step, working, host.now())) {
    // Arm the wake the quiet period is waiting on. Only when the session is idle: a batch held
    // behind a live turn is re-checked when that turn ends, and arming here would race it.
    if (!working) {
      const at = externalHoldUntil(step, host.now());
      if (at !== undefined) host.scheduleDelivery(jobId, stepId, at);
    }
    return;
  }
  const { step: drained } = drainForDelivery(step);
  const round = { id: host.newId(), action: step.controller, delivered: drained.lastDelivered };
  host.mutateStep(jobId, stepId, () => ({ ...drained, pendingRound: round }));
  host.resumeController(jobId, stepId, undefined, undefined, round.id);
}
