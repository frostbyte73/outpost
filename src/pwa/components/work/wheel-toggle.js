import { escapeHtml } from '../session-view/html.js';

// Is the user driving this session right now? Server-derived (job.live.interactiveSessionIds,
// see src/work/job-liveness.ts) rather than client state, so every surface showing the job
// agrees without its own bookkeeping.
function isDriven(job, sessionId) {
  return !!sessionId && (job?.live?.interactiveSessionIds ?? []).includes(sessionId);
}

// The take-the-wheel / hand-back control. Wired by wireTimelineStep, which runs after
// syncInlineMounts — so the copy the inline feed renders from its own skeleton is already in
// the DOM by the time the step card goes looking for [data-step-action].
export function wheelButtonHtml(sessionId, driven) {
  return `<button type="button" class="o-btn o-btn--default sm step-wheel"
            data-step-action="${driven ? 'hand-back' : 'take-wheel'}"
            data-wheel-session="${escapeHtml(sessionId)}">${driven ? 'Hand back' : 'Take the wheel'}</button>`;
}

// One step's session feed. Undriven, the mount carries `data-wheel-session` so the feed puts
// the control on its own status line (inline-session.js) instead of a row above it. Driven,
// the mount is the full session view and the way out rides in the frame's bar — .sv-header is
// the only chrome inside that view that could hold it, and it's hidden on mobile.
export function stepFeedHtml(job, s) {
  if (!s.sessionId) return '';
  const driven = isDriven(job, s.sessionId);
  const mount = `<div class="step-inline-session-mount${driven ? ' step-inline-session-mount--driven' : ''}"`
    + ` data-session-id="${escapeHtml(s.sessionId)}" data-step-id="${escapeHtml(s.id)}"`
    + `${driven ? '' : ` data-wheel-session="${escapeHtml(s.sessionId)}"`}></div>`;
  if (!driven) return mount;
  return `
    <div class="step-drive">
      <div class="step-drive-bar">
        <span class="step-drive-label">You have the wheel</span>
        ${wheelButtonHtml(s.sessionId, true)}
      </div>
      ${mount}
    </div>`;
}
