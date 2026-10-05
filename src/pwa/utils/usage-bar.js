// Shared account-usage bar math + popover markup — the desktop sidebar-foot
// widget (shell/sidebar.js) and the mobile header's compact usage widget both
// need the same tier thresholds and the same popover content, just mounted into
// different chrome (popover vs. bottom sheet). D3: thresholds unify on 70/90.

import { fmtResetAt } from './formatting.js';

export const WARN_PCT = 70;
export const HOT_PCT = 90;

export function usageTier(pct) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  if (pct >= HOT_PCT) return 'hot';
  if (pct >= WARN_PCT) return 'warn';
  return 'ok';
}

export function clampPct(pct) {
  return Math.min(100, Math.max(0, pct));
}

export function fmtUsd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return `$${n.toFixed(2)}`;
}

export function fmtDurationMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
    '&#39;'
  ));
}

// The usage window holding the job queue right now ('five_hour' | 'seven_day'), or null. A window
// the user is ignoring holds nothing. Both meters (sidebar, mobile header) tint this one's row.
export function heldWindow(q) {
  return q?.blocker && !q.ignoreBudgetUntil ? q.blocker : null;
}

// The blocking window's override, as an info bubble that floats beside its block on hover (or on
// focus, which is how a touch screen gets it) and takes no room in the popover: "Ignore for 1h"
// while the window holds the queue, the end time + "Restore" while it's being ignored.
function blockerTipHtml(key, q) {
  if (!q || q.blocker !== key) return '';
  const ignored = !!q.ignoreBudgetUntil;
  const note = ignored ? `<span>Ignored until ${escapeHtml(fmtClock(q.ignoreBudgetUntil))}</span>` : '';
  const [action, label] = ignored ? ['restore-budget', 'Restore'] : ['ignore-budget', 'Ignore limit for 1h'];
  return `
      <div class="o-usage-pop-tip" role="tooltip"><div class="o-usage-pop-tip-body">${note}<button type="button" class="o-usage-pop-btn" data-queue-action="${action}">${label}</button></div></div>`;
}

function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function windowBlockHtml(label, win, key, q) {
  const pct = win?.used_percentage;
  const hasPct = typeof pct === 'number' && Number.isFinite(pct);
  const clamped = hasPct ? clampPct(pct) : 0;
  const held = heldWindow(q) === key;
  const tip = blockerTipHtml(key, q);
  const tier = held ? 'paused' : hasPct ? usageTier(clamped) : 'ok';
  return `
    <div class="o-usage-pop-block${held ? ' is-blocking' : ''}${tip ? ' has-tip' : ''}"${tip ? ' tabindex="0"' : ''}>
      <div class="o-usage-pop-row">
        <span class="o-usage-pop-k">${escapeHtml(label)}</span>
        <span class="o-usage-pop-v">${hasPct ? `${Math.round(clamped)}% used · ${escapeHtml(fmtResetAt(win.resets_at))}` : 'no data yet'}</span>
      </div>
      <div class="o-usage-pop-bar"><span class="o-usage-pop-fill${tier === 'ok' ? '' : ` ${tier}`}" style="width:${clamped}%"></span></div>${tip}
    </div>`;
}

function breakdownHtml(breakdown) {
  if (!breakdown) return '';
  const rows = (breakdown.perModel ?? [])
    .map((m) => `<span>${escapeHtml(m.model)}</span><span class="val">${fmtUsd(m.costUsd)}</span>`)
    .join('');
  const burn = typeof breakdown.burnRatePerHour === 'number' ? `${fmtUsd(breakdown.burnRatePerHour)}/h` : '—';
  const runway = fmtDurationMs(breakdown.estimatedRunwayMs) ?? '—';
  return `
    <div class="o-usage-pop-block">
      <div class="o-usage-pop-meta">
        <span>Burn rate: ${burn}</span>
        <span>Est. runway: ${runway}</span>
      </div>
      ${rows ? `<div class="o-usage-pop-breakdown">${rows}</div>` : ''}
    </div>`;
}

// Shared between the desktop sidebar-foot popover and the mobile header's usage
// sheet — same content, different container chrome around it.
// What a hold on the job launch queue means — how many wait, why, when it opens — for the
// wordmark tag's tooltip (queueTag). Null while it just runs, or before the daemon has reported
// the queue at all.
export function launchQueueParts(q) {
  if (!q) return null;
  const waiting = q.parked ? `${q.parked} waiting` : null;
  if (q.paused) {
    return {
      state: 'paused', head: 'Job queue paused',
      why: waiting ? `${waiting} · nothing starts on its own` : 'Nothing starts on its own',
      runAll: !!q.parked,
    };
  }
  if (!q.parked) return null;
  const why = String(q.reason ?? '').replace(/^Waiting — /, '');
  return {
    state: 'held', head: `Held · ${waiting}`,
    why: q.opensAt ? `${why} · opens ${fmtResetAt(q.opensAt / 1000)}` : why,
    runAll: true,
  };
}

// The sidebar brand row's one-word queue state, beside "Outpost": `paused` is the user's pause,
// `held` the budget or busy slots keeping launches back. The tooltip carries what the line under
// the meter used to; the full line with Run all stays in the usage popover. Null while it just runs.
export function queueTag(q) {
  if (!q) return null;
  if (q.paused) return { text: 'paused', tone: 'paused', title: `Job queue paused${q.parked ? ` · ${q.parked} waiting` : ''}` };
  const p = launchQueueParts(q);
  return p ? { text: 'held', tone: 'held', title: `${p.head} — ${p.why}` } : null;
}

// Same stroke style as the sidebar's own icons (shell/sidebar.js svg()), so the toggle sits in
// that nav as one of them.
function icon(path) {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}
export const iconPause = () => icon('<rect x="6.5" y="5" width="3.5" height="14" rx="1"/><rect x="14" y="5" width="3.5" height="14" rx="1"/>');
export const iconPlay = () => icon('<path d="M8 5.5v13l10.5-6.5z"/>');

// What the pause/resume control shows: pause while running, play while paused. `title` is the
// whole state in one line, for the collapsed sidebar where only the icon is left.
export function queueToggle(q) {
  const paused = !!q?.paused;
  const waiting = q?.parked ? ` · ${q.parked} waiting` : '';
  return paused
    ? { action: 'resume', label: 'Resume queue', icon: iconPlay(), paused, title: `Job queue paused${waiting} — resume it` }
    : { action: 'pause', label: 'Pause queue', icon: iconPause(), paused, title: `Job queue running${waiting} — pause it` };
}

// The queue action a click asked for, if any — the sidebar nav item and the mobile sheet's toggle
// both delegate through this, so the markup's attribute lives in one file.
export function queueActionFor(target) {
  return target?.closest?.('[data-queue-action]')?.dataset.queueAction ?? null;
}

// The job queue's slots, in the same block shape as the two token windows: how many job turns run
// in parallel against the configured cap. On mobile, which has no sidebar nav item for it, the
// queue's pause/resume rides this block's header. `active` can exceed `slots` (a user launch takes
// one without waiting), so the bar clamps and the text says the real count.
function slotBlockHtml(q, withToggle) {
  if (!q || !Number.isFinite(q.slots) || q.slots < 1) return '';
  const active = q.active ?? 0;
  const pct = clampPct((active / q.slots) * 100);
  // Waiting is always said, zero included: it is the other half of what the bar is about.
  const state = ` · ${q.parked ?? 0} waiting${q.paused ? ' · paused' : ''}`;
  const t = withToggle ? queueToggle(q) : null;
  const toggle = t
    ? `<button type="button" class="o-usage-pop-btn" data-queue-action="${t.action}" aria-label="${t.label}">${t.icon}<span>${t.paused ? 'Resume' : 'Pause'}</span></button>`
    : '';
  return `
    <div class="o-usage-pop-block">
      <div class="o-usage-pop-row">
        <span class="o-usage-pop-k">Job slots${toggle}</span>
        <span class="o-usage-pop-v">${active} of ${q.slots} running${escapeHtml(state)}</span>
      </div>
      <div class="o-usage-pop-bar"><span class="o-usage-pop-fill" style="width:${pct}%"></span></div>
    </div>`;
}

export function usagePopoverHtml(au, queue, { queueToggle: withToggle = false } = {}) {
  return `
    <div class="o-usage-pop-hdr"><h4>Account usage</h4></div>
    ${windowBlockHtml('5-hour window', au?.five_hour, 'five_hour', queue)}
    ${windowBlockHtml('Weekly window', au?.seven_day, 'seven_day', queue)}
    ${slotBlockHtml(queue, withToggle)}
    ${breakdownHtml(au?.breakdown)}
  `;
}
