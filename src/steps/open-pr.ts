import type { JobRecord, OpenPrStep } from '../work/work-types.js';
import { writeEnvelope } from '../work/envelope.js';
import type { ExternalEvent, StepHandler } from './types.js';

function previousFindings(job: JobRecord, selfId: string) {
  return job.steps
    .filter((st) => st.id !== selfId && st.type === 'action' && st.forwardOutput !== false && st.output)
    .map((st) => ({
      id: st.id,
      title: st.title,
      action: (st as { action?: string }).action,
      output: (st as { output?: string }).output,
    }));
}

export const openPrHandler: StepHandler<OpenPrStep> = {
  type: 'open-pr',
  initialState: 'implementing',

  isResolved(s) { return s.state === 'merged'; },

  decide(s, job, ctx) {
    if (s.cancelled || s.failure) return null;
    switch (s.state) {
      case 'implementing': {
        if (s.sessionId) return null;
        const envelope = openPrHandler.buildEnvelope(s, job, ctx);
        const path = writeEnvelope(ctx.jobsDir, job.id, s.id, envelope);
        return { kind: 'spawn-session', jobId: job.id, stepId: s.id, envelopePath: path };
      }
      case 'comment_pending_response':
      case 'reply_pending_review': {
        // One resumable session per step: don't open a triage round while an edit
        // round is mid-flight on the same session.
        if ((s.editQueue ?? []).some((e) => e.status === 'running')) return null;
        const drafted = new Set((s.draftedReplies ?? []).map((d) => d.commentId));
        const undrafted = (s.comments ?? []).filter((c) => !c.respondedAt && !drafted.has(c.id));
        if (undrafted.length === 0) return null;
        const busy = (s.iterations ?? []).some((it) => it.kind === 'replies' && it.status === 'in_progress' && !it.postedAt);
        if (busy) return null;
        const envelope = openPrHandler.buildEnvelope(s, job, ctx);
        const path = writeEnvelope(ctx.jobsDir, job.id, s.id, envelope);
        return { kind: 'spawn-session', jobId: job.id, stepId: s.id, envelopePath: path };
      }
      case 'pr_open': {
        const ready = s.prState === 'open'
          && s.ciState === 'success'
          && s.reviewState === 'approved';
        if (ready) return { kind: 'request-merge-approval', jobId: job.id, stepId: s.id };
        return null;
      }
      case 'conflicting': {
        if (s.conflictResolving) return null;
        return { kind: 'request-conflict-approval', jobId: job.id, stepId: s.id };
      }
      case 'conflict_unresolved':
        return null;
      case 'merged':
      case 'failed':
        return null;
    }
  },

  buildEnvelope(s, job) {
    return {
      kind: 'step',
      jobId: job.id,
      stepId: s.id,
      type: 'open-pr',
      title: s.title,
      description: s.description,
      goal: s.goal,
      approach: s.approach,
      risks: s.risks,
      job: {
        source: job.source,
        title: job.title,
        description: job.description,
        externalRef: job.externalRef,
      },
      previousSteps: previousFindings(job, s.id),
      workspace: s.workspace,
      typePayload: {
        branch: s.workspace.branch,
        round: (s.state === 'comment_pending_response' || s.state === 'reply_pending_review')
          ? {
              kind: 'pr-comments',
              comments: (s.comments ?? []).filter((c) => {
                if (c.respondedAt) return false;
                const drafted = (s.draftedReplies ?? []).some((d) => d.commentId === c.id);
                return !drafted;
              }),
            }
          : 'initial',
      },
    };
  },

  onExternalEvent(s, ev): OpenPrStep {
    switch (ev.kind) {
      case 'pr-discovered':
        return {
          ...s,
          prUrl: ev.prUrl,
          prState: 'open',
          state: s.state === 'implementing' ? 'pr_open' : s.state,
        };
      case 'pr-state-changed':
        return {
          ...s,
          prState: ev.prState,
          state: ev.prState === 'merged' ? 'merged' : s.state,
        };
      case 'ci-state-changed':
        return { ...s, ciState: ev.ciState };
      case 'review-state-changed':
        return { ...s, reviewState: ev.reviewState };
      case 'pr-comments-changed':
        return { ...s, comments: ev.comments as OpenPrStep['comments'] };
    }
  },
};

export type { ExternalEvent };
