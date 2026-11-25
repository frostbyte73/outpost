// Tracked drill-in — the redesign's "one scrollable story": sticky header,
// plan card (work/plan-section.js: plan-level chrome + compact step index),
// a steps timeline (work/step-card.js's renderTimelineStep/wireTimelineStep —
// the ONE full-step renderer), and the bottom "+ Add step". Mobile mounts this
// same renderer via mobile-shell's mountListDetailScreens (with a focus card
// wrapped above it) — there is no separate mobile job-detail view.

import { work } from '../../state/work.js';
import { nav } from '../../state/nav.js';
import { prPatches } from '../../state/pr-patches.js';
import { worktreeChanges } from '../../state/worktree-changes.js';
import { renderPlanSection, wirePlanPreapprovals, PLAN_ACTIONS, wirePlanActions } from '../work/plan-section.js';
import { planIsLive } from '../../vm/work-predicates.js';
import { renderTimelineStep, wireTimelineStep, computeGroupPositions } from '../work/step-card.js';
import { openAddStepDialog } from '../work/add-step-dialog.js';
import { openActionPickerDialog } from '../work/action-picker-dialog.js';
import { jobTone, ago, STATE_LABEL, launchPillClass } from '../work/ticket-row.js';
import { loadRuntimeOptions } from '../../net/sessions.js';
import { jobLaunchBadge } from '../../vm/tracked.js';
import { syncInlineMounts, teardownAllExcept } from './session-mounts.js';
import { wireAutogrow } from '../../utils/autogrow.js';
import { snapshotUi, restoreUi } from '../work/repaint-ui.js';
import { shortName } from '../../utils/formatting.js';

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

// Per-job "edit plan" toggle, module-local: it's UI mode, not job state, so it
// must survive store-driven repaints without a round-trip.
const editingPlanByJob = new Map();
function isEditingPlan(jobId) { return editingPlanByJob.get(jobId) === true; }
// Mirrors engine.ts's stepAcceptsEdits (whose own comment cross-references this one) — a step
// is editable and cancellable before it starts, and again once it has FAILED, so the inputs that
// caused the failure can be corrected in place. Only a live session with no failure is locked:
// it has already read the envelope the patch would rewrite. Anything this enables that the
// server would still refuse just 409s, so the two rules have to stay identical.
export function stepIsEditable(s) {
  if (s.cancelled) return false;
  if (s.state === 'resolved') return false;
  if (s.sessionId && !s.failure) return false;
  return true;
}

// Reordering keeps the STRICTER rule: engine.ts's reorderSteps still locks any step that ever
// had a session to its original index, failed or not — moving one would reshuffle the parallel
// groups around work that already ran. So the arrows can't ride on stepIsEditable.
export function stepIsMovable(s) {
  return stepIsEditable(s) && !s.sessionId;
}

// The disabled tool's tooltip has to name the actual blocker: a failed step is editable now, so
// the only thing these tools are withheld from is a step that is still mid-turn or already over.
export function editBlockedReason(s) {
  if (s.state === 'resolved') return 'Step already finished';
  if (s.type === 'action' && s.state === 'declined') return 'You denied this step’s write draft';
  if (s.cancelled) return 'Step is cancelled';
  return 'Step is still running — editable once it finishes or fails';
}

function moveBlockedReason(s) {
  if (!stepIsEditable(s)) return editBlockedReason(s);
  return 'Step has already run — it keeps its place in the plan';
}

function primaryRepo(job) {
  for (const s of job.steps ?? []) {
    if (s.workspace?.repoCwd) return s.workspace.repoCwd;
  }
  return null;
}

const SOURCE_LABELS = { manual: 'Manual', 'pr-review': 'PR review' };

function renderHeader(job) {
  const extId = job.externalRef?.issueIdentifier ?? '';
  const url = job.externalRef?.url ?? '';
  const sourceLabel = SOURCE_LABELS[job.source] ?? 'Linear';
  const tone = jobTone(job);
  const label = (job.state === 'planning' && !job.orchestratorSessionId) ? 'Todo' : (STATE_LABEL[job.state] ?? job.state);
  const repo = primaryRepo(job);
  const syncingThis = work.get().syncingJobId === job.id;

  return `
    <header class="tk-hdr">
      <div class="tk-breadcrumb">Tracked / ${escapeHtml(extId || job.title || '')}</div>
      <div class="tk-title-row">
        ${extId ? `<span class="o-ref">${escapeHtml(extId)}</span>` : ''}
        <h1 class="tk-title">${escapeHtml(job.title ?? '')}</h1>
        <span class="job-state-pill" data-tone="${tone}">${escapeHtml(label)}</span>
        <div class="tk-actions">
          <button class="work-sync-btn" type="button" data-action="sync-job" ${syncingThis ? 'disabled' : ''} title="Refresh PR status">${syncingThis ? '…' : '↻'}</button>
          <div class="tk-menu">
            <button type="button" class="o-btn o-btn--ghost" data-action="toggle-menu" aria-haspopup="true" aria-expanded="false">⋯</button>
            <div class="tk-menu-body" hidden>
              <button type="button" class="tk-menu-item" data-job-action="rerun-latest">${job.steps?.some((s) => !s.cancelled && s.failure) ? 'Rerun failed step' : 'Rerun latest step'}</button>
              <button type="button" class="tk-menu-item danger" data-job-action="reset-job">Reset job</button>
              ${job.state !== 'abandoned' && job.state !== 'done' ? `<button type="button" class="tk-menu-item" data-job-action="mark-done">Mark done</button>` : ''}
              ${job.state !== 'abandoned' && job.state !== 'done' ? `<button type="button" class="tk-menu-item danger" data-job-action="abandon-job">Abandon</button>` : ''}
              ${job.source === 'manual' ? `<button type="button" class="tk-menu-item danger" data-job-action="delete-job">Delete</button>` : ''}
            </div>
          </div>
          <button class="work-sync-btn tk-rail-toggle" type="button" data-action="toggle-rail" title="Toggle right panel" aria-label="Toggle right panel"><span class="tk-rail-hide">»</span><span class="tk-rail-show">«</span></button>
        </div>
      </div>
      <div class="tk-meta">
        <span class="tk-meta-item">${escapeHtml(sourceLabel)}${url ? ` · <a href="${escapeHtml(url)}" target="_blank" rel="noopener">open ↗</a>` : ''}</span>
        ${repo ? `<span class="tk-meta-item">${escapeHtml(shortName(repo))}</span>` : ''}
        <span class="tk-meta-item">Started ${ago(job.createdAt)} ago</span>
      </div>
      ${renderLaunchRow(job)}
    </header>
  `;
}

// Token-launch-queue status + controls — its own inner row so it never crowds
// onto the title/state or source/repo/started lines above (header-spacing rule).
function renderLaunchRow(job) {
  const badge = jobLaunchBadge(job);
  const showPriorityToggle = job.state !== 'done' && job.state !== 'abandoned';
  if (!badge && !showPriorityToggle) return '';
  return `
    <div class="tk-launch-row">
      ${showPriorityToggle ? '<label class="o-field"><span>Runtime</span><select class="o-select tk-runtime" disabled></select></label><span class="tk-runtime-error" role="status"></span>' : ''}
      ${badge ? `<span class="o-pill ${launchPillClass(badge.kind)}">${escapeHtml(badge.label)}</span>` : ''}
      ${showPriorityToggle ? `
        <label class="tk-priority-toggle" title="Run immediately, ignore the token queue">
          <input type="checkbox" class="tk-priority-checkbox" ${job.highPriority ? 'checked' : ''}>
          High priority — run immediately, ignore the token queue
        </label>
      ` : ''}
    </div>
  `;
}

function editTools(s, editable, canMoveUp, canMoveDown) {
  const blockedReason = editBlockedReason(s);
  const moveReason = escapeHtml(moveBlockedReason(s));
  return `
    <div class="step-edit-tools" data-step-id="${escapeHtml(s.id)}">
      <button class="step-edit-tool" type="button" data-step-action="move-up"   aria-label="Move up"   ${canMoveUp ? '' : 'disabled'} title="${canMoveUp ? 'Move up' : moveReason}">▲</button>
      <button class="step-edit-tool" type="button" data-step-action="move-down" aria-label="Move down" ${canMoveDown ? '' : 'disabled'} title="${canMoveDown ? 'Move down' : moveReason}">▼</button>
      <button class="step-edit-tool" type="button" data-step-action="edit-step" aria-label="Edit" ${editable ? '' : 'disabled'} title="${editable ? 'Edit step' : escapeHtml(blockedReason)}">✎</button>
      <button class="step-edit-tool danger" type="button" data-step-action="cancel-step" aria-label="Cancel" ${editable ? '' : 'disabled'} title="${editable ? 'Cancel step' : escapeHtml(blockedReason)}">×</button>
    </div>
  `;
}

function insertButton(attrs) {
  return `
    <button class="plan-insert" type="button" ${attrs}>
      <span class="plan-insert-line"></span><span class="plan-insert-label">+ insert</span><span class="plan-insert-line"></span>
    </button>
  `;
}

function renderStepsTimeline(job) {
  const liveSteps = (job.steps ?? []).filter((s) => !s.cancelled);
  if (!liveSteps.length) return '';
  const positions = computeGroupPositions(liveSteps);
  const editing = isEditingPlan(job.id) && job.state === 'executing';

  const rows = liveSteps.map((s, i) => {
    let insert = '';
    // Inserting BEFORE a step that already ran would reorder it behind work it followed, which
    // is the same thing reorderSteps refuses — so this rail tracks movability, not editability.
    if (editing && i === 0 && stepIsMovable(s)) {
      insert = insertButton(`data-job-action="insert-step-before" data-before-id="${escapeHtml(s.id)}"`);
    } else if (editing && i > 0) {
      insert = insertButton(`data-job-action="insert-step-after" data-after-id="${escapeHtml(liveSteps[i - 1].id)}"`);
    }
    let tools = '';
    if (editing) {
      const movable = stepIsMovable(s);
      const prev = i > 0 ? liveSteps[i - 1] : null;
      const next = i < liveSteps.length - 1 ? liveSteps[i + 1] : null;
      tools = editTools(s, stepIsEditable(s), movable && prev && stepIsMovable(prev), movable && next && stepIsMovable(next));
    }
    return insert + renderTimelineStep(job, s, i, positions[i], { editTools: tools });
  }).join('');

  // Just the rail — the "Steps" heading + Edit-plan toggle moved up into the
  // single Plan header (plan-section.js). This renders inside that section now.
  return `<div class="tl-rail">${rows}</div>`;
}

export function renderTrackedDetail(root, jobId) {
  const job = jobId ? work.get().byId.get(jobId) : null;
  teardownAllExcept(jobId);

  if (!job) {
    root.__tkPaintKey = null;
    root.innerHTML = `<div class="o-frame-empty">Loading job ${escapeHtml(jobId ?? '')}…</div>`;
    return;
  }

  // Skip no-op repaints: work-store events for *other* jobs fire subscribers
  // too, and rebuilding would churn inline session mounts for nothing. launchStatus,
  // highPriority and `live` are folded in explicitly — each changes without bumping the
  // job's own `updatedAt`.
  //
  // `live` matters most: it's derived per broadcast, never persisted, and the daemon
  // re-sends an otherwise identical job purely to flip it (rebroadcastJobLiveness in
  // daemon.ts) — which the work store keeps on purpose (mergeOne's strict `>`). It is also
  // the ONLY thing the inline feed has to tell a streaming session from a parked one
  // (syncInlineMounts → mountInlineSession's `live`). Left out of this key, a controller
  // woken by a message from the diff view keeps rendering its parked status chip ("⏸
  // Implement") for the whole turn — reading as "nothing is happening" — until some
  // unrelated mutation bumps updatedAt, or the user leaves the detail and comes back.
  const editing = isEditingPlan(job.id);
  // prPatches.version is folded in for the same reason as `live`: PR file diffs land after the
  // job record and change what the comment threads render, without touching job.updatedAt.
  // worktreeChanges.version is the same story for the diff button's variant, and only moves
  // when a re-read actually returns a different count.
  const paintKey = `${job.id}:${job.updatedAt}:${work.get().syncingJobId === job.id}:${editing}:${job.highPriority}:${JSON.stringify(job.launchStatus ?? null)}:${JSON.stringify(job.live ?? null)}:${prPatches.get().version}:${worktreeChanges.get().version}:${[...work.get().openingWaits].join(',')}`;
  if (root.__tkPaintKey === paintKey && root.querySelector('.tk-shell')) return;
  root.__tkPaintKey = paintKey;

  const snap = root.querySelector('.tk-shell') ? snapshotUi(root) : null;
  if (root.__tkMenuClose) { document.removeEventListener('click', root.__tkMenuClose); root.__tkMenuClose = null; }

  // While the FIRST plan is being drafted or reviewed the plan card's compact index is the
  // story; the timeline takes over once steps have actually run — including through a later
  // replan, which flips job state back to planning/plan_pending_review over steps that already
  // ran (planIsLive). Both live under the single Plan section now — the timeline is handed to
  // renderPlanSection rather than rendered as a separate "Steps" block.
  const showTimeline = planIsLive(job);
  const editingTimeline = editing && job.state === 'executing';
  const timelineHtml = showTimeline ? renderStepsTimeline(job) : '';

  root.innerHTML = `
    <div class="tk-shell">
      ${renderHeader(job)}
      <div class="tk-body">
        <div id="tk-plan">${renderPlanSection(job, { timelineHtml, editing: editingTimeline })}</div>
      </div>
    </div>
  `;

  syncInlineMounts(root, job);

  root.querySelectorAll('.tl-step').forEach((el) => {
    const stepId = el.getAttribute('data-step-id');
    const step = (job.steps ?? []).find((s) => s.id === stepId);
    if (step) wireTimelineStep(el, job, step);
  });

  // Every `data-autogrow` composer in the tree at once — the step's message box, its gate
  // note, and both write-draft boxes. Must run before restoreUi, which replays an `input`
  // event to carry half-typed text back in and relies on these listeners already being up.
  wireAutogrow(root);

  const menuBtn = root.querySelector('[data-action="toggle-menu"]');
  const menuBody = root.querySelector('.tk-menu-body');
  if (menuBtn && menuBody) {
    const closeMenu = () => {
      menuBody.setAttribute('hidden', '');
      menuBtn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', closeMenu);
      root.__tkMenuClose = null;
    };
    const openMenu = () => {
      menuBody.removeAttribute('hidden');
      menuBtn.setAttribute('aria-expanded', 'true');
      root.__tkMenuClose = closeMenu;
      setTimeout(() => document.addEventListener('click', closeMenu), 0);
    };
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menuBody.hasAttribute('hidden')) openMenu(); else closeMenu();
    });
    if (snap?.menuOpen) openMenu();
  }

  const syncBtn = root.querySelector('[data-action="sync-job"]');
  if (syncBtn) syncBtn.addEventListener('click', () => void work.syncJob(job.id));
  // The same toggle the session view's header carries — shell/surfaces.js turns the store flag into
  // .o-frame.context-collapsed, which is also what picks this button's arrow (tracked.css).
  root.querySelector('[data-action="toggle-rail"]')?.addEventListener('click', () => nav.toggleContextCollapsed());

  const planScope = `plan:${job.id}`;
  wirePlanPreapprovals(root, planScope);
  wirePlanActions(root, job);
  root.querySelectorAll('[data-job-action]').forEach((el) => {
    if (PLAN_ACTIONS.has(el.getAttribute('data-job-action'))) return;
    el.addEventListener('click', (e) => {
      const action = el.getAttribute('data-job-action');
      if (el.closest('summary')) { e.preventDefault(); e.stopPropagation(); }
      if (action === 'add-step-end') openActionPickerDialog(job.id);
      else if (action === 'toggle-edit-plan') {
        editingPlanByJob.set(job.id, !isEditingPlan(job.id));
        renderTrackedDetail(root, job.id);
      }
      else if (action === 'insert-step-after') {
        const after = el.getAttribute('data-after-id') ?? undefined;
        openActionPickerDialog(job.id, { afterStepId: after });
      }
      else if (action === 'insert-step-before') {
        const before = el.getAttribute('data-before-id') ?? undefined;
        openActionPickerDialog(job.id, { beforeStepId: before });
      }
      else if (action === 'rerun-latest') {
        if (!confirm('Re-run the most recent step? Its prior output will be replaced.')) return;
        void work.rerunLatest(job.id).catch((e) => alert(`Rerun failed: ${e?.message ?? e}`));
      }
      else if (action === 'reset-job') {
        if (!confirm('Reset this job? Steps and plan will be wiped; back to planning. Any active sessions stay open — close them manually.')) return;
        void work.resetJob(job.id).catch((e) => alert(`Reset failed: ${e?.message ?? e}`));
      }
      else if (action === 'mark-done') {
        const linear = job.source === 'linear' ? ' The Linear ticket will be set to Done.' : '';
        if (!confirm(`Mark this job done? Unfinished steps will be cancelled, active sessions closed, and worktrees archived.${linear}`)) return;
        void work.markDone(job.id).catch((e) => alert(`Mark done failed: ${e?.message ?? e}`));
      }
      else if (action === 'abandon-job') {
        if (!confirm('Abandon this job? Active sessions will be closed and worktrees archived. The record stays for history.')) return;
        void work.abandon(job.id).catch((e) => alert(`Abandon failed: ${e?.message ?? e}`));
      }
      else if (action === 'delete-job') {
        if (!confirm('Delete this job? Sessions will be closed, worktrees archived, and the record removed. This cannot be undone.')) return;
        void work.deleteJob(job.id).catch((e) => alert(`Delete failed: ${e?.message ?? e}`));
      }
    });
  });

  const priorityToggle = root.querySelector('.tk-priority-checkbox');
  const runtimeSelect = root.querySelector('.tk-runtime');
  if (runtimeSelect) {
    let current = job.runtime ?? 'claude';
    const error = root.querySelector('.tk-runtime-error');
    void loadRuntimeOptions(runtimeSelect, current).catch((e) => { error.textContent = e.message; });
    runtimeSelect.addEventListener('change', async () => {
      runtimeSelect.disabled = true;
      error.textContent = '';
      try { await work.setJobRuntime(job.id, runtimeSelect.value); current = runtimeSelect.value; }
      catch (e) { runtimeSelect.value = current; error.textContent = e.message; }
      finally { runtimeSelect.disabled = false; }
    });
  }
  if (priorityToggle) {
    priorityToggle.addEventListener('change', () => {
      void work.setPriority(job.id, priorityToggle.checked)
        .catch((e) => { alert(`Priority update failed: ${e?.message ?? e}`); priorityToggle.checked = !priorityToggle.checked; });
    });
  }

  root.querySelectorAll('.step-edit-tools').forEach((toolsEl) => {
    const stepId = toolsEl.getAttribute('data-step-id');
    toolsEl.querySelectorAll('[data-step-action]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (btn.hasAttribute('disabled')) return;
        const kind = btn.getAttribute('data-step-action');
        if (kind === 'edit-step') {
          const step = (job.steps ?? []).find((x) => x.id === stepId);
          if (step) openAddStepDialog(job.id, { editStep: step });
          return;
        }
        if (kind === 'cancel-step') {
          try { await work.cancelStep(job.id, stepId); }
          catch (err) { alert(`Cancel failed: ${err?.message ?? err}`); }
          return;
        }
        if (kind === 'move-up' || kind === 'move-down') {
          const live = (job.steps ?? []).filter((s) => !s.cancelled);
          const idx = live.findIndex((s) => s.id === stepId);
          if (idx < 0) return;
          const j = kind === 'move-up' ? idx - 1 : idx + 1;
          if (j < 0 || j >= live.length) return;
          const ids = (job.steps ?? []).map((s) => s.id);
          const liveSet = new Set(live.map((s) => s.id));
          const liveIdsInOrder = [...live];
          [liveIdsInOrder[idx], liveIdsInOrder[j]] = [liveIdsInOrder[j], liveIdsInOrder[idx]];
          let li = 0;
          for (let k = 0; k < ids.length; k++) {
            if (liveSet.has(ids[k])) ids[k] = liveIdsInOrder[li++].id;
          }
          try { await work.reorderSteps(job.id, ids); }
          catch (err) { alert(`Reorder failed: ${err?.message ?? err}`); }
        }
      });
    });
  });

  if (snap) restoreUi(root, snap);
}
