import type { JobRecord, SessionStall } from './work-types.js';
import { isTerminalStep } from '../steps/index.js';
import type { LaunchState } from './launch-governor.js';

export interface JobLiveness {
  orchestrator: boolean;
  stepIds: string[];
  // Every session on this job whose subprocess is alive right now — the orchestrator's, each
  // step's own, and each dispatch child's. `stepIds` deliberately folds a running dispatch
  // INTO its parent step (a controller that has fanned out isn't idle work), which makes it
  // the wrong signal for "is THIS session streaming". The inline feed needs that per-session
  // answer to choose between a transcript tail and a status chip, and can't derive it
  // client-side: the sessions store's `runState` is forced to 'foreground' by the act of
  // mounting the feed at all (recomputeRunState in state/sessions.js).
  sessionIds: string[];
  // Sessions the user has taken the wheel on. Deliberately independent of `sessionIds`: a
  // driven session is usually NOT mid-turn (it is waiting on the user), and the step card
  // still has to render a composer for it.
  interactiveSessionIds: string[];
}

export interface JobLaunchStatus {
  job: LaunchState;
  steps: Record<string, LaunchState>;
}

// The job shape sent to the PWA: the persisted record plus derived, never-persisted
// `live` (which sessions currently have a live subprocess) and `launchStatus` (the
// token-launch-queue governor's running/queued/idle view) snapshots.
export type JobWithLiveness = JobRecord & { live: JobLiveness; launchStatus: JobLaunchStatus };

// StopFailure errors that a fresh sign-in repairs. These resume on their own after re-auth; every
// other stall waits for the user, since retrying into a rate limit or a billing error just stalls
// again.
export const AUTH_STOP_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed']);

// The stalls that still describe a session the job is waiting on: that session is still the
// orchestrator's / step's / dispatch's current one, and what owns it hasn't settled. A retry, a
// cold respawn, a resolve or a cancel all leave the recorded entry behind, so this — not the raw
// field — is what the PWA shows and what a resume acts on.
export function currentStalls(job: JobRecord): SessionStall[] {
  if (job.state === 'done' || job.state === 'failed' || job.state === 'abandoned') return [];
  return (job.stalls ?? []).filter((st) => {
    if (!st.stepId) return job.orchestratorSessionId === st.sessionId;
    const s = job.steps.find((x) => x.id === st.stepId);
    if (!s || isTerminalStep(s)) return false;
    if (!st.dispatchId) return s.sessionId === st.sessionId;
    const d = s.type === 'orchestrated' ? s.dispatches.find((x) => x.id === st.dispatchId) : undefined;
    return d?.status === 'running' && d.sessionId === st.sessionId;
  });
}

export function withLiveness(
  job: JobRecord,
  isActive: (sessionId?: string) => boolean,
  isInteractive: (sessionId?: string) => boolean = () => false,
): JobRecord & { live: JobLiveness } {
  const stepIds: string[] = [];
  const alive = new Set<string>();
  const driven = new Set<string>();
  const note = (sessionId?: string) => {
    if (!sessionId) return;
    if (isActive(sessionId)) alive.add(sessionId);
    if (isInteractive(sessionId)) driven.add(sessionId);
  };
  note(job.orchestratorSessionId);
  for (const s of job.steps) {
    if (s.cancelled) continue;
    note(s.sessionId);
    // A dispatch child's session is the step's work too — without it, a controller that
    // has fanned out and gone quiet reads as idle for the whole fan-out.
    const childLive = s.type === 'orchestrated'
      && s.dispatches.some((d) => d.status === 'running' && isActive(d.sessionId));
    if (s.type === 'orchestrated') for (const d of s.dispatches) note(d.sessionId);
    if (isActive(s.sessionId) || childLive) stepIds.push(s.id);
  }
  return {
    ...job,
    stalls: currentStalls(job),
    live: {
      orchestrator: isActive(job.orchestratorSessionId),
      stepIds,
      sessionIds: [...alive],
      interactiveSessionIds: [...driven],
    },
  };
}

// Shared by every place a JobRecord crosses the wire (GET /api/work/jobs[/:id] and the
// WS work_job_changed broadcast) so liveness + launch status can't drift between them.
export function serializeJob(
  job: JobRecord,
  isActive: (sessionId?: string) => boolean,
  launchStatusFor: (job: JobRecord) => JobLaunchStatus,
  isInteractive?: (sessionId?: string) => boolean,
): JobWithLiveness {
  return { ...withLiveness(job, isActive, isInteractive), launchStatus: launchStatusFor(job) };
}
