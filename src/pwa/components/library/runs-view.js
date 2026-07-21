// Runs history — main-only surface (rail · main, no list column). Cross-
// category chronological log: sessions, tracked-job steps, scheduled runs.
// Registered as the 'runs' surface's renderDetail in shell/surfaces.js.

import { runs } from '../../state/runs.js';
import { runsApi } from '../../net/runs.js';
import { escapeHtml } from '../../util.js';
import {
  runsRows, runSkill, uniqueSkills, uniqueRepos, verdictTone,
  formatDurationMs, formatCostUsd, formatRunWhen, formatDayLabel, dayKey,
} from '../../vm/runs.js';
import { openRunDetail } from '../../app-bridge.js';
import { wireOverflowMenu } from '../../utils/overflow-menu.js';
import { bindRowActivation } from '../../utils/row-activation.js';

const WINDOW_OPTIONS = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
];
const KIND_OPTIONS = [
  { value: 'all', label: 'All kinds' },
  { value: 'sess', label: 'Session' },
  { value: 'track', label: 'Tracked' },
  { value: 'sched', label: 'Scheduled' },
];
const VERDICT_OPTIONS = [
  { value: 'all', label: 'All verdicts' },
  { value: 'ok', label: 'Clean' },
  { value: 'warn', label: 'Needs attention' },
  { value: 'hot', label: 'Failed' },
  { value: 'info', label: 'In progress' },
];

// Filtering strategy: `window` is the only dimension sent to the server (it
// bounds how much of the ledger to even fetch); kind/skill/repo/verdict are
// applied client-side via vm/runs.js's runsRows over that window-scoped set —
// changing them just repaints, no refetch. `skill` has no server-side
// equivalent at all (RunFilters has no skill field; see vm/runs.js's runSkill).
const FETCH_LIMIT = 500;

export function renderDetail(mount) {
  let filters = { window: '7d', kind: 'all', skill: 'all', repo: 'all', verdict: 'all' };
  let groupByDay = false;

  const pending = runs.consumePendingFilter();
  if (pending) filters = { ...filters, window: 'all', ...pending };

  mount.textContent = '';
  const view = document.createElement('div');
  view.className = 'runs-view';
  mount.appendChild(view);
  // Delegated once on the persistent view element — survives paint()'s
  // innerHTML replacement, so role=button rows answer Enter/Space.
  bindRowActivation(view);

  function paint() {
    const s = runs.get();
    const { rows, tally } = runsRows(s.runs, filters, Date.now());
    view.innerHTML = layoutHtml(s, rows, tally, filters, groupByDay);
    wire();
  }

  function wire() {
    wireOverflowMenu(view);
    for (const sel of view.querySelectorAll('.runs-filter-select')) {
      sel.addEventListener('change', (e) => {
        const key = sel.dataset.filter;
        filters = { ...filters, [key]: e.target.value };
        if (key === 'window') reload();
        else paint();
      });
    }
    view.querySelector('.runs-groupday')?.addEventListener('click', () => {
      groupByDay = !groupByDay;
      paint();
    });
    for (const el of view.querySelectorAll('.runs-row[data-run-id]')) {
      el.addEventListener('click', () => {
        const run = runs.get().runs.find((r) => r.id === el.dataset.runId);
        if (run) openRunDetail(run);
      });
    }
  }

  function reload() {
    runs.load({ window: filters.window, limit: FETCH_LIMIT });
  }

  paint();
  reload();
  const unsub = runs.subscribe(paint);
  return () => unsub();
}

function csvUrl(filters) {
  const q = {};
  if (filters.window !== 'all') q.window = filters.window;
  if (filters.kind !== 'all') q.kind = filters.kind;
  if (filters.repo !== 'all') q.repo = filters.repo;
  // skill/verdict have no server-side filter (client-only tone/sub heuristics)
  // so the CSV export can't honor them — window/kind/repo still narrow it usefully.
  return runsApi.csvUrl(q);
}

function layoutHtml(s, rows, tally, filters, groupByDay) {
  return `
    <div class="runs-hdr">
      <h1 class="runs-title">Runs history</h1>
      <span class="runs-lede">Every session, tracked step, and scheduled run · newest first</span>
      <div class="runs-hdr-actions">
        <div class="o-menu">
          <button type="button" class="o-btn o-btn--ghost o-menu-toggle" data-menu-toggle aria-haspopup="true" aria-expanded="false" aria-label="More actions">⋯</button>
          <div class="o-menu-body" hidden>
            <a class="o-btn o-btn--ghost" href="${escapeHtml(csvUrl(filters))}" download="runs.csv">Export CSV</a>
            <button type="button" class="o-btn o-btn--ghost runs-groupday${groupByDay ? ' active' : ''}">Group by day${groupByDay ? ' ✓' : ''}</button>
          </div>
        </div>
      </div>
    </div>
    ${filtersHtml(filters, s.runs, tally)}
    <div class="runs-table-wrap">
      <div class="runs-table">
        <div class="runs-table-hdr o-microhead">
          <div>When</div><div>What</div><div>Where</div><div>Verdict</div><div>Duration</div>
          <div class="r-align-right">Cost</div><div class="r-align-center">Kind</div>
        </div>
        <div class="runs-table-body">
          ${s.loading && rows.length === 0 ? '<div class="runs-empty">Loading…</div>' : tableRowsHtml(rows, groupByDay)}
        </div>
      </div>
    </div>
  `;
}

function filtersHtml(filters, allRuns, tally) {
  const skills = uniqueSkills(allRuns);
  // An active skill filter handed over from a skill detail ("View all runs")
  // may not exist in the loaded window — keep it as a real option so the
  // select shows what's actually filtering instead of lying with "All skills".
  if (filters.skill !== 'all' && !skills.includes(filters.skill)) skills.unshift(filters.skill);
  const skillOptions = [{ value: 'all', label: 'All skills' }, ...skills.map((v) => ({ value: v, label: v }))];
  const repoOptions = [{ value: 'all', label: 'All repos' }, ...uniqueRepos(allRuns).map((v) => ({ value: v, label: v }))];
  return `
    <div class="runs-filters">
      ${selectHtml('window', WINDOW_OPTIONS, filters.window)}
      ${selectHtml('kind', KIND_OPTIONS, filters.kind)}
      ${selectHtml('skill', skillOptions, filters.skill)}
      ${selectHtml('repo', repoOptions, filters.repo)}
      ${selectHtml('verdict', VERDICT_OPTIONS, filters.verdict)}
      <span class="runs-tally">${tally.count} run${tally.count === 1 ? '' : 's'} · ${formatDurationMs(tally.totalDurationMs)} total · ${formatCostUsd(tally.totalCostUsd)}</span>
    </div>
  `;
}

function selectHtml(key, options, value) {
  return `
    <label class="runs-filter-chip">
      <select class="runs-filter-select" data-filter="${key}" aria-label="${key}">
        ${options.map((o) => `<option value="${escapeHtml(o.value)}"${o.value === value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
      </select>
    </label>
  `;
}

function tableRowsHtml(rows, groupByDay) {
  if (rows.length === 0) return '<div class="runs-empty">No runs match these filters.</div>';
  if (!groupByDay) return rows.map(rowHtml).join('');
  let lastKey = null;
  const parts = [];
  for (const r of rows) {
    const k = dayKey(r.startedAt);
    if (k !== lastKey) {
      lastKey = k;
      parts.push(`<div class="runs-day-hdr o-microhead">${escapeHtml(formatDayLabel(r.startedAt))}</div>`);
    }
    parts.push(rowHtml(r));
  }
  return parts.join('');
}

// Last-3-segments cwd, matching the sessions cards' treatment — the tail is
// the informative part; the full path lives in the title tooltip.
function shortCwd(cwd) {
  if (!cwd) return '—';
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length <= 3) return cwd;
  return '…/' + parts.slice(-3).join('/');
}

function rowHtml(r) {
  const tone = verdictTone(r.verdict);
  const skill = runSkill(r);
  return `
    <div class="o-row runs-row" data-run-id="${escapeHtml(r.id)}" role="button" tabindex="0">
      <div class="r-when">${escapeHtml(formatRunWhen(r.startedAt))}</div>
      <div class="r-what">
        <div class="r-what-title">${escapeHtml(r.title ?? '')}</div>
        ${r.sub || skill ? `<div class="r-what-sub">${escapeHtml(r.sub ?? skill ?? '')}</div>` : ''}
      </div>
      <div class="r-where" title="${escapeHtml(r.cwd ?? '')}">${escapeHtml(shortCwd(r.cwd))}</div>
      <div class="r-verdict ${tone}">${escapeHtml(r.verdict ?? '—')}</div>
      <div class="r-dur">${escapeHtml(formatDurationMs(r.durationMs))}</div>
      <div class="r-cost">${escapeHtml(formatCostUsd(r.costUsd))}</div>
      <div class="r-kind"><span class="kind-badge kind-${escapeHtml(r.kind)}">${escapeHtml(r.kind)}</span></div>
    </div>
  `;
}
