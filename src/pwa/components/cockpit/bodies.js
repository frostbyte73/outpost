// A cockpit row's expanded body. The action body holds only what the row is waiting on; the caret
// body is the row's full story. Both mount the same renderers Tracked and Sessions use.

import { work } from '../../state/work.js';
import { nav } from '../../state/nav.js';
import { orchestratedRows } from '../../vm/tracked.js';
import { isTerminalStep } from '../../vm/work-predicates.js';
import {
  controllerGateHtml, controllerGateActionsHtml, controllerComposerHtml,
  artifactTrailHtml, wireArtifactTrail, wireControllerControls,
} from '../work/controller-controls.js';
import { renderPlanSection, wirePlanActions, wirePlanPreapprovals } from '../work/plan-section.js';
import { renderWriteDraft, wireWriteDraft } from '../work/write-draft-card.js';
import { stepDotState } from '../work/ticket-row.js';
import { actionCategory, actionDisplayName } from '../work/action-icon.js';
import { openAddStepDialog } from '../work/add-step-dialog.js';
import { mountSessionView } from '../session-view/index.js';
import { sessionsApi } from '../../net/sessions.js';
import { wireAutogrow } from '../../utils/autogrow.js';
import { relPast } from '../../utils/formatting.js';
import { escapeHtml } from '../../util.js';

function stepOf(job, id) { return (job?.steps ?? []).find((s) => s.id === id) ?? null; }

function openFullHtml(label = 'Open in Tracked ↗') {
  return `<div class="ckb-body-actions"><button type="button" class="o-btn o-btn--ghost sm" data-ckb-body="open-full">${label}</button></div>`;
}

const ACTION_HTML = {
  gate(job, a) {
    const vm = orchestratedRows(stepOf(job, a.stepId));
    return `<div data-ckb-step="${escapeHtml(a.stepId)}">${controllerGateHtml(vm)}${controllerGateActionsHtml(vm)}</div>`;
  },
  'plan-review'(job) { return `<div data-ckb-plan>${renderPlanSection(job, {})}</div>`; },
  draft(job, a) {
    const draft = (stepOf(job, a.stepId)?.drafts ?? []).find((d) => d.id === a.draftId);
    return draft ? `<div data-ckb-draft="${escapeHtml(a.draftId)}">${renderWriteDraft(draft)}</div>` : '';
  },
  failed(job, a) {
    return `<div class="ckb-failure">${escapeHtml(a.reason)}</div>
      <div class="ckb-body-actions">
        <button type="button" class="o-btn o-btn--primary" data-ckb-body="retry" data-step-id="${escapeHtml(a.stepId ?? '')}">Retry</button>
        ${a.stepId ? `<button type="button" class="o-btn o-btn--default" data-ckb-body="edit-step" data-step-id="${escapeHtml(a.stepId)}">Edit step</button>` : ''}
      </div>`;
  },
  wait(job, a) {
    return `<div class="ckb-tl-sub">${escapeHtml(a.reason || 'Holding until you resume.')}</div>
      <div class="ckb-body-actions">
        <button type="button" class="o-btn o-btn--primary" data-ckb-body="resume-wait" data-step-id="${escapeHtml(a.stepId)}">Resume</button>
        <button type="button" class="o-btn o-btn--danger" data-ckb-body="abandon">Abandon job</button>
      </div>`;
  },
  stall(job, a) {
    return `<div class="ckb-body-actions"><button type="button" class="o-btn o-btn--primary" data-ckb-body="${a.auth ? 'sign-in' : 'resume-stalled'}">${a.auth ? 'Sign in' : 'Resume'}</button></div>`;
  },
  driven(job, a) {
    return `<div class="ckb-body-actions"><button type="button" class="o-btn o-btn--default sm" data-ckb-body="hand-back" data-session-id="${escapeHtml(a.sessionId)}">Hand back</button></div>
      <div class="ckb-session" data-ckb-session="${escapeHtml(a.sessionId)}"></div>`;
  },
};

function actionBodyHtml(job, model) {
  return model.actions.map((a) => ACTION_HTML[a.kind]?.(job, a) ?? '').join('') + openFullHtml();
}

function timelineHtml(job, now) {
  const steps = (job.steps ?? []).filter((s) => !s.cancelled);
  if (!steps.length) return '';
  const rows = steps.map((s) => {
    const action = s.type === 'action' ? s.action : s.controller;
    const vm = s.type === 'orchestrated' ? orchestratedRows(s) : null;
    return `
      <span class="step-dot" data-state="${stepDotState(s)}"></span>
      <span>${escapeHtml(s.title ?? '')}</span>
      <span class="type-mono" data-cat="${escapeHtml(actionCategory(action))}">${escapeHtml(actionDisplayName(action))}</span>
      <span class="ckb-tl-age">${escapeHtml(relPast(s.updatedAt ?? job.updatedAt, now) ?? '')}</span>
      ${vm?.statusLine ? `<span class="ckb-tl-sub">${escapeHtml(vm.statusLine)}</span>` : ''}
      ${vm?.artifactRows.length ? `<span class="ckb-tl-sub" data-ckb-step="${escapeHtml(s.id)}">${artifactTrailHtml(s, vm)}</span>` : ''}`;
  }).join('');
  return `<div class="ckb-tl">${rows}</div>`;
}

function liveController(job) {
  return (job.steps ?? []).find((s) => s.type === 'orchestrated' && !s.cancelled && !isTerminalStep(s)) ?? null;
}

function caretJobHtml(job) {
  if (!job.steps?.length || job.state === 'plan_pending_review') {
    return `<div data-ckb-plan>${renderPlanSection(job, {})}</div>${openFullHtml()}`;
  }
  const ctl = liveController(job);
  return timelineHtml(job, Date.now())
    + (ctl ? `<div data-ckb-step="${escapeHtml(ctl.id)}">${controllerComposerHtml(ctl)}</div>` : '')
    + openFullHtml();
}

function textareaKey(ta, i) {
  return ta.closest('[data-composer]')?.getAttribute('data-composer') ?? (ta.id || `#${i}`);
}

// Typed text must survive a body re-render on a live job.
function rerender(el, html, wire) {
  const typed = new Map();
  el.querySelectorAll('textarea').forEach((ta, i) => { if (ta.value) typed.set(textareaKey(ta, i), ta.value); });
  el.innerHTML = html;
  wire();
  el.querySelectorAll('textarea').forEach((ta, i) => {
    const value = typed.get(textareaKey(ta, i));
    if (value == null) return;
    ta.value = value;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.closest('[data-composer]')?.removeAttribute('hidden');
  });
}

function wireJobBody(el, job, model, sessionMounts) {
  el.querySelectorAll('[data-ckb-step]').forEach((wrap) => {
    const step = stepOf(job, wrap.getAttribute('data-ckb-step'));
    if (!step) return;
    wireArtifactTrail(wrap);
    wireControllerControls(wrap, job, step);
  });
  if (el.querySelector('[data-ckb-plan]')) {
    wirePlanActions(el, job);
    wirePlanPreapprovals(el, `plan:${job.id}`);
  }
  for (const a of model.actions) {
    if (a.kind !== 'draft') continue;
    const draft = (stepOf(job, a.stepId)?.drafts ?? []).find((d) => d.id === a.draftId);
    if (draft) wireWriteDraft(el, { jobId: job.id, stepId: a.stepId, draft });
  }
  el.querySelectorAll('[data-ckb-session]').forEach((m) => {
    const id = m.getAttribute('data-ckb-session');
    sessionMounts.set(id, mountSessionView(m, id, { jobId: job.id, scopedHotkeys: true }));
  });
  el.querySelectorAll('[data-ckb-body]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const kind = btn.getAttribute('data-ckb-body');
      const stepId = btn.getAttribute('data-step-id') || null;
      if (kind === 'open-full') nav.select('tracked', job.id);
      else if (kind === 'retry') void (stepId ? work.retryStep(job.id, stepId) : work.rerunLatest(job.id));
      else if (kind === 'edit-step') { const s = stepOf(job, stepId); if (s) openAddStepDialog(job.id, { editStep: s }); }
      else if (kind === 'resume-wait') void work.approve(job.id, { gate: 'wait', stepId });
      else if (kind === 'abandon') { if (confirm('Abandon this job? Active sessions will be closed and worktrees archived.')) void work.abandon(job.id); }
      else if (kind === 'resume-stalled') void work.resumeStalled(job.id);
      else if (kind === 'sign-in') nav.select('settings', 'claude-account');
      else if (kind === 'hand-back') void sessionsApi.setInteractive(btn.getAttribute('data-session-id'), false);
    });
  });
  wireAutogrow(el);
}

function mountJobBody(el, model, mode) {
  const sessionMounts = new Map();
  let sig = null;
  const paint = (m) => {
    const job = work.get().byId.get(m.id);
    if (!job) return;
    const next = mode === 'action'
      ? `a|${JSON.stringify(m.actions)}|${(job.steps ?? []).map((s) => (s.gate?.draft ?? '').length).join(',')}`
      : `c|${job.updatedAt}`;
    if (next === sig) return;
    sig = next;
    for (const h of sessionMounts.values()) h.unmount();
    sessionMounts.clear();
    const html = mode === 'action' ? actionBodyHtml(job, m) : caretJobHtml(job);
    rerender(el, html, () => wireJobBody(el, job, m, sessionMounts));
  };
  paint(model);
  return {
    update: paint,
    unmount() { for (const h of sessionMounts.values()) h.unmount(); el.textContent = ''; },
  };
}

function mountSessionBody(el, model) {
  el.innerHTML = `<div class="ckb-session"></div>
    <div class="ckb-body-actions"><button type="button" class="o-btn o-btn--ghost sm" data-ckb-body="open-full">Open full ↗</button></div>`;
  const view = mountSessionView(el.querySelector('.ckb-session'), model.id, { cwd: model.cwd, scopedHotkeys: true });
  el.querySelector('[data-ckb-body="open-full"]').addEventListener('click', (e) => {
    e.stopPropagation();
    nav.select('sessions', model.id);
  });
  return { update() {}, unmount() { view.unmount(); el.textContent = ''; } };
}

export function mountBody(el, model, mode) {
  if (model.kind === 'session') return mountSessionBody(el, model);
  if (model.kind === 'job') return mountJobBody(el, model, mode);
  el.textContent = '';
  return { update() {}, unmount() {} };
}
