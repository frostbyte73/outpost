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

function windowBlockHtml(label, win) {
  const pct = win?.used_percentage;
  const hasPct = typeof pct === 'number' && Number.isFinite(pct);
  const clamped = hasPct ? clampPct(pct) : 0;
  const tier = hasPct ? usageTier(clamped) : 'ok';
  return `
    <div class="o-usage-pop-block">
      <div class="o-usage-pop-row">
        <span class="o-usage-pop-k">${escapeHtml(label)}</span>
        <span class="o-usage-pop-v">${hasPct ? `${Math.round(clamped)}% used · ${escapeHtml(fmtResetAt(win.resets_at))}` : 'no data yet'}</span>
      </div>
      <div class="o-usage-pop-bar"><span class="o-usage-pop-fill${tier === 'ok' ? '' : ` ${tier}`}" style="width:${clamped}%"></span></div>
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
// The launch queue as one line under the meter: a pause holds every queued job at once, so it
// belongs beside the usage that causes it, not only as a label on each job. Null when nothing waits.
export function launchQueueParts(q) {
  if (!q?.parked) return null;
  const why = String(q.reason ?? '').replace(/^Waiting — /, '');
  return {
    head: `Paused · ${q.parked} waiting`,
    why: q.opensAt ? `${why} · opens ${fmtResetAt(q.opensAt / 1000)}` : why,
  };
}

export function launchQueueHtml(q) {
  const p = launchQueueParts(q);
  if (!p) return '';
  return `
    <div class="o-usage-queue">
      <div class="o-usage-queue-head"><span>${escapeHtml(p.head)}</span><button type="button" class="o-usage-queue-run" data-run-all-queued>Run all</button></div>
      <div class="o-usage-queue-why">${escapeHtml(p.why)}</div>
    </div>`;
}

export function usagePopoverHtml(au, queue) {
  return `
    <div class="o-usage-pop-hdr"><h4>Account usage</h4></div>
    ${launchQueueHtml(queue)}
    ${windowBlockHtml('5-hour window', au?.five_hour)}
    ${windowBlockHtml('Weekly window', au?.seven_day)}
    ${breakdownHtml(au?.breakdown)}
  `;
}
