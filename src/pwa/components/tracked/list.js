// Tracked list column — live jobs most-recently-active first, then Done (vm/tracked.js's
// trackedRows), rendered as o-row cards. Reuses ticket-row.js's pure
// derivation (jobTone/ago/stepDots) rather than reimplementing job-state math.

import { work } from '../../state/work.js';
import { nav } from '../../state/nav.js';
import { setHtmlIfChanged } from '../../utils/keyed-rows.js';
import { trackedRows, jobLaunchBadge, jobStatus, jobStepStatus } from '../../vm/tracked.js';
import { ago, stepDots, launchPillClass } from '../work/ticket-row.js';

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

// Shape and colour both differ per status, so it doesn't rest on colour alone; only `running`
// pulses (DESIGN.md §8 — the pulse is reserved for what's genuinely live).
const STATUS_ICON = {
  running: { glyph: '●', cls: 'busy', label: 'Running' },
  'needs-you': { glyph: '●', cls: 'warn', label: 'Needs you' },
  failed: { glyph: '●', cls: 'hot', label: 'Failed' },
  queued: { glyph: '◌', cls: 'busy', label: 'Queued' },
  waiting: { glyph: '◐', cls: 'idle', label: 'Waiting' },
  backlog: { glyph: '○', cls: 'idle', label: 'Backlog' },
  done: { glyph: '●', cls: 'ok', label: 'Done' },
};

// Tones a step status can carry (vm/tracked.js's statusOf), mapped onto .o-row-icon's state
// classes. Untoned statuses rest at `idle` like any parked row.
const STEP_TONE_CLS = { ok: 'ok', warn: 'warn' };

// A parked job says what it is parked on — "→ Ready to merge", "✗ CI failing" — rather than a
// generic half-circle. Only for waiting / needs-you: a running job's pulse, and the terminal
// and queued icons, already say the truer thing.
function stepStatusFor(j, kind) {
  return kind === 'waiting' || kind === 'needs-you' ? jobStepStatus(j) : null;
}

function rowHtml(j) {
  const kind = jobStatus(j);
  const step = stepStatusFor(j, kind);
  const status = step
    ? { glyph: step.glyph, cls: STEP_TONE_CLS[step.tone] ?? (kind === 'needs-you' ? 'warn' : 'idle'), label: step.text }
    : STATUS_ICON[kind];
  const stepLabel = step
    ? `<span class="tracked-step-status ${status.cls}" title="${escapeHtml(step.detail ?? step.text)}">${escapeHtml(step.text)}</span>` : '';
  const ref = j.externalRef?.issueIdentifier ?? '';
  // The icon says queued; the pill says why (which token window it's waiting on).
  const badge = jobLaunchBadge(j);
  const queuedPill = badge?.kind === 'queued'
    ? `<span class="o-pill ${launchPillClass(badge.kind)}">${escapeHtml(badge.label)}</span>` : '';
  return `
    <button type="button" class="o-row lr-row" data-job-id="${escapeHtml(j.id)}">
      <span class="o-row-icon ${status.cls} tracked-status" data-status="${kind}" title="${escapeHtml(status.label)}" aria-label="${escapeHtml(status.label)}">${escapeHtml(status.glyph)}</span>
      <span class="tracked-row-body">
        <div class="o-row-title">${ref ? `<span class="o-ref">${escapeHtml(ref)}</span>` : ''}${escapeHtml(j.title ?? '(untitled)')}</div>
        <div class="o-row-sub">${stepDots(j)}${stepLabel}${queuedPill}</div>
      </span>
      <span class="o-row-time">${ago(j.updatedAt)}</span>
    </button>
  `;
}

function groupHtml(title, jobs) {
  if (!jobs.length) return '';
  return `
    <div class="o-group-hdr"><h3>${escapeHtml(title)}</h3><span class="o-group-count">${jobs.length}</span><span class="o-group-rule"></span></div>
    <div class="o-row-group">${jobs.map(rowHtml).join('')}</div>
  `;
}

function collapsedGroupHtml(title, jobs, open) {
  if (!jobs.length) return '';
  return `
    <details class="o-group-collapse" ${open ? 'open' : ''}>
      <summary class="o-group-hdr"><span class="o-group-title">${escapeHtml(title)}</span><span class="o-group-count">${jobs.length}</span><span class="o-group-rule"></span></summary>
      <div class="o-row-group">${jobs.map(rowHtml).join('')}</div>
    </details>
  `;
}

export function renderTrackedList(body) {
  let doneOpen = false;
  const paint = () => {
    const jobs = work.get().jobs ?? [];
    const { active, done } = trackedRows(jobs);
    const html = [
      groupHtml('Active', active),
      collapsedGroupHtml('Done', done, doneOpen),
    ].join('');
    // Guarded: a work-store event for ANY job notifies every subscriber, and a
    // row's step dots (.step-dot[data-state="running"]) pulse forever — a rebuild
    // restarts them. renderTrackedDetail guards the same way with its paintKey.
    // Skipping also avoids re-binding a click handler per row.
    if (!setHtmlIfChanged(body, html || '<div class="lr-empty">No jobs in the queue yet.</div>')) {
      highlightSelected();
      return;
    }
    highlightSelected();
    body.querySelectorAll('.lr-row').forEach((el) => {
      el.addEventListener('click', () => nav.select('tracked', el.dataset.jobId));
    });
    const doneEl = body.querySelector('.o-group-collapse');
    if (doneEl) doneEl.addEventListener('toggle', () => { doneOpen = doneEl.open; });
  };
  const highlightSelected = () => {
    const selected = nav.get().selectionBySurface.tracked ?? null;
    for (const el of body.querySelectorAll('.lr-row')) {
      el.classList.toggle('is-open', !!selected && el.dataset.jobId === selected);
    }
  };
  paint();
  const unsubWork = work.subscribe(paint);
  const unsubNav = nav.subscribe(highlightSelected);
  return () => { unsubWork(); unsubNav(); };
}
