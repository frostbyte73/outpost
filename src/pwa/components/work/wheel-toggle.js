import { escapeHtml } from '../session-view/html.js';

// Is the user driving this session right now? Server-derived (job.live.interactiveSessionIds,
// see src/work/job-liveness.ts) rather than client state, so every surface showing the job
// agrees without its own bookkeeping.
export function isDriven(job, sessionId) {
  return !!sessionId && (job?.live?.interactiveSessionIds ?? []).includes(sessionId);
}

// The take-the-wheel / hand-back control for one session's feed. Rendered by both step-card
// (action steps) and orchestrated-card (controllers); wired by wireTimelineStep.
export function wheelRowHtml(job, sessionId) {
  if (!sessionId) return '';
  const driven = isDriven(job, sessionId);
  return `
    <div class="step-wheel-row">
      <button type="button" class="o-btn o-btn--default step-wheel"
              data-step-action="${driven ? 'hand-back' : 'take-wheel'}"
              data-wheel-session="${escapeHtml(sessionId)}">
        ${driven ? 'Hand back' : 'Take the wheel'}
      </button>
    </div>`;
}
