// A cockpit row's expanded body. The action body holds only what the row is waiting on; the caret
// body is the row's full story. Both mount the same renderers Tracked and Sessions use.

import { work } from '../../state/work.js';
import { nav } from '../../state/nav.js';
import { orchestratedRows } from '../../vm/tracked.js';
import { isTerminalStep } from '../../vm/work-predicates.js';
import { OPENABLE } from '../../vm/cockpit-board.js';
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

function fieldKey(f, i) {
  return f.closest('[data-composer]')?.getAttribute('data-composer') ?? (f.id || `${f.tagName}#${i}`);
}

// Typed text, checkbox state and focus must survive a body rebuild on a live job.
function rerender(el, html, wire) {
  const saved = new Map();
  let focusKey = null;
  let selection = null;
  el.querySelectorAll('textarea, input').forEach((f, i) => {
    const key = fieldKey(f, i);
    saved.set(key, f.type === 'checkbox' ? { checked: f.checked } : { value: f.value });
    if (f === document.activeElement) {
      focusKey = key;
      selection = [f.selectionStart, f.selectionEnd];
    }
  });
  el.innerHTML = html;
  wire();
  el.querySelectorAll('textarea, input').forEach((f, i) => {
    const key = fieldKey(f, i);
    const prev = saved.get(key);
    if (prev) {
      if ('checked' in prev) f.checked = prev.checked;
      else if (prev.value) {
        f.value = prev.value;
        f.dispatchEvent(new Event('input', { bubbles: true }));
        f.closest('[data-composer]')?.removeAttribute('hidden');
      }
    }
    if (key === focusKey) {
      f.focus();
      try { f.setSelectionRange(selection[0], selection[1]); } catch { /* not a text field */ }
    }
  });
}

function wireBodyButtons(el, job) {
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
}

function wireStepControls(el, job) {
  el.querySelectorAll('[data-ckb-step]').forEach((wrap) => {
    const step = stepOf(job, wrap.getAttribute('data-ckb-step'));
    if (!step) return;
    wireArtifactTrail(wrap);
    wireControllerControls(wrap, job, step);
  });
}

function wireActionBody(el, job, model, sessionMounts) {
  wireStepControls(el, job);
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
  wireBodyButtons(el, job);
  wireAutogrow(el);
}

// Rebuilt only when what it renders changes — an approval elsewhere on the job isn't in it.
function mountActionBody(el, model) {
  const sessionMounts = new Map();
  let sig = null;
  const paint = (m) => {
    const job = work.get().byId.get(m.id);
    if (!job) return;
    const shown = m.actions.filter((a) => OPENABLE.has(a.kind));
    const next = `${JSON.stringify(shown)}|${shown.map((a) => (stepOf(job, a.stepId)?.gate?.draft ?? '').length).join(',')}`;
    if (next === sig) return;
    sig = next;
    for (const h of sessionMounts.values()) h.unmount();
    sessionMounts.clear();
    rerender(el, actionBodyHtml(job, { ...m, actions: shown }), () => wireActionBody(el, job, m, sessionMounts));
  };
  paint(model);
  return {
    update: paint,
    unmount() { for (const h of sessionMounts.values()) h.unmount(); el.textContent = ''; },
  };
}

function isPlanView(job) {
  return !job.steps?.length || job.state === 'plan_pending_review';
}

// The timeline repaints with the job; the composer region is only rebuilt when the live
// controller changes, so typing in it survives every watcher sync.
function mountCaretBody(el, model) {
  let layout = null;
  let tlHtml = null;
  let composerFor;
  let regions = null;

  const build = (job) => {
    layout = isPlanView(job) ? 'plan' : 'tl';
    el.innerHTML = layout === 'plan'
      ? `<div data-ckb-region="plan"></div>${openFullHtml()}`
      : `<div data-ckb-region="tl"></div><div data-ckb-region="compose"></div>${openFullHtml()}`;
    regions = {
      plan: el.querySelector('[data-ckb-region="plan"]'),
      tl: el.querySelector('[data-ckb-region="tl"]'),
      compose: el.querySelector('[data-ckb-region="compose"]'),
    };
    tlHtml = null;
    composerFor = undefined;
    wireBodyButtons(el, job);
  };

  const paint = (m) => {
    const job = work.get().byId.get(m.id);
    if (!job) return;
    if (layout !== (isPlanView(job) ? 'plan' : 'tl')) build(job);
    if (layout === 'plan') {
      const html = `<div data-ckb-plan>${renderPlanSection(job, {})}</div>`;
      if (html === tlHtml) return;
      tlHtml = html;
      rerender(regions.plan, html, () => {
        wirePlanActions(regions.plan, job);
        wirePlanPreapprovals(regions.plan, `plan:${job.id}`);
        wireAutogrow(regions.plan);
      });
      return;
    }
    const html = timelineHtml(job, Date.now());
    if (html !== tlHtml) {
      const open = [...regions.tl.querySelectorAll('.orc-trail-chip.is-open')]
        .map((c) => [c.closest('[data-ckb-step]')?.getAttribute('data-ckb-step'), c.getAttribute('data-trail-chip')]);
      tlHtml = html;
      regions.tl.innerHTML = html;
      wireStepControls(regions.tl, job);
      for (const [stepId, slug] of open) {
        regions.tl.querySelector(`[data-ckb-step="${CSS.escape(stepId ?? '')}"] .orc-trail-chip[data-trail-chip="${CSS.escape(slug ?? '')}"]`)?.click();
      }
    }
    const ctl = liveController(job);
    if ((ctl?.id ?? null) !== composerFor) {
      composerFor = ctl?.id ?? null;
      regions.compose.innerHTML = ctl ? `<div data-ckb-step="${escapeHtml(ctl.id)}">${controllerComposerHtml(ctl)}</div>` : '';
      if (ctl) {
        wireControllerControls(regions.compose, job, ctl);
        wireAutogrow(regions.compose);
      }
    }
  };
  paint(model);
  return { update: paint, unmount() { el.textContent = ''; } };
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
  if (model.kind === 'job') return mode === 'action' ? mountActionBody(el, model) : mountCaretBody(el, model);
  el.textContent = '';
  return { update() {}, unmount() {} };
}
