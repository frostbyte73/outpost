import type { JobRecord, Preapprovals, Step } from '../work/work-types.js';
import type { ActionRegistry } from '../actions/registry.js';

export type Action =
  | { kind: 'spawn-session'; jobId: string; stepId: string; envelopePath: string }
  | { kind: 'spawn-orchestrator'; jobId: string; mode: 'initial' | 'replan'; envelopePath: string }
  // A step with `delaySec` just became next: stamp its `startAt` and arm the wake.
  | { kind: 'arm-start-delay'; jobId: string; stepId: string }
  // meta.session (builtin runner): park the step and start the user's session on it.
  | { kind: 'start-session'; jobId: string; stepId: string }
  // meta.job (builtin runner): create or link the step's child job.
  | { kind: 'start-child-job'; jobId: string; stepId: string }
  | { kind: 'deliver-inbox'; jobId: string; stepId: string }
  | { kind: 'write-linear-in-progress'; linearUuid: string; jobId: string }
  | { kind: 'write-linear-in-review';   linearUuid: string; jobId: string }
  | { kind: 'write-linear-done';        linearUuid: string; jobId: string };

export interface HandlerCtx {
  jobsDir: string;
  newId: () => string;
  now: () => number;
  // Lets a step handler read an action's frontmatter (e.g. runner) at decide time.
  // Optional so tests can construct a ctx without a registry.
  actionRegistry?: ActionRegistry;
  // Is this session one the user has taken the wheel on? Optional for the same reason as
  // actionRegistry — a test ctx need not supply it, and absent reads as "on autopilot".
  isInteractive?: (sessionId: string) => boolean;
  preapprovalDefaults?: () => Preapprovals | undefined;
  prReviewers?: () => string[];
}

export interface StepHandler<S extends Step> {
  type: S['type'];
  initialState: S['state'];
  isResolved(step: S): boolean;
  decide(step: S, job: JobRecord, ctx: HandlerCtx): Action | null;
  buildEnvelope(step: S, job: JobRecord, ctx: HandlerCtx): object;
}
