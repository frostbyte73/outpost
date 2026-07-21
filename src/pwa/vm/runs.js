// Runs-history view-model: pure filter/sort/tally over the runs-ledger record
// shape (plan D4.2): {id, kind:'sess'|'track'|'sched', title, sub, cwd, verdict,
// startedAt, durationMs, costUsd, refs}.

import { formatDuration } from '../utils/formatting.js';

const WINDOW_MS = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

function withinWindow(run, window, now) {
  if (!window || window === 'all') return true;
  const span = WINDOW_MS[window];
  if (!span) return true;
  return now - (run.startedAt ?? 0) <= span;
}

function matchesKind(run, kind) {
  return !kind || kind === 'all' || run.kind === kind;
}

function matchesSkill(run, skill) {
  if (!skill || skill === 'all') return true;
  return runSkill(run) === skill;
}

function matchesRepo(run, repo) {
  if (!repo || repo === 'all') return true;
  return (run.cwd ?? '') === repo;
}

// Verdict is a free-form human phrase ("Client-side · closed", "2 issues
// found · 1 open") with no separate machine tone field on RunRecord, so the
// filter operates on the same tone heuristic used for row coloring rather
// than an arbitrary substring — 'ok'/'warn'/'hot'/'info' are the only valid
// filter values (see verdictTone below).
function matchesVerdict(run, verdict) {
  if (!verdict || verdict === 'all') return true;
  return verdictTone(run.verdict) === verdict;
}

// The run ledger doesn't carry a distinct "skill" field — the invoking skill
// is folded into `sub` by runs-capture.ts: `schedule?.skill` for sched runs,
// `schedule?.skill ?? issueIdentifier` for track runs, nothing for plain
// sessions. Extract the leading token, but reject Linear issue identifiers
// ("ABC-142") — the track-run fallback — so ticket ids never masquerade as
// skills in the filter dropdown.
export function runSkill(run) {
  const sub = String(run?.sub ?? '').trim();
  if (!sub) return null;
  const first = sub.split(' · ')[0].trim();
  if (!first || /free-form/i.test(first)) return null;
  if (/^[A-Z][A-Z0-9]*-\d+$/.test(first)) return null;
  return first.replace(/^\//, '');
}

export function uniqueSkills(runs = []) {
  return [...new Set(runs.map(runSkill).filter(Boolean))].sort();
}

export function uniqueRepos(runs = []) {
  return [...new Set(runs.map((r) => r.cwd).filter(Boolean))].sort();
}

// Heuristic tone classifier over the verdict phrase — no machine-readable
// tone exists on RunRecord (D4.2's shape is `verdict?: string`), so this
// pattern-matches the same vocabulary the daemon writes today. Order matters:
// failure words win over the "in progress" words, which win over the default
// "clean" (ok) tone.
export function verdictTone(verdict) {
  const v = String(verdict ?? '').toLowerCase();
  if (!v) return 'info';
  if (/abort|error|denied|failed|✕/.test(v)) return 'hot';
  if (/running|idle|◇/.test(v)) return 'info';
  if (/pending|issue|thread|skip|drift|stuck|◆/.test(v)) return 'warn';
  return 'ok';
}

export function formatDurationMs(ms) {
  return formatDuration(ms) ?? '—';
}

export function formatCostUsd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return `$${n.toFixed(2)}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }

// Calendar-aware relative label matching the mockup's "14:39" / "yesterday ·
// 22:15" / "Sun · 09:00" progression — same day drops the date entirely,
// within a week uses the weekday, older falls back to a short date.
export function formatRunWhen(ts, now = Date.now()) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const dayDiff = Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS);
  if (dayDiff <= 0) return time;
  if (dayDiff === 1) return `yesterday · ${time}`;
  if (dayDiff < 7) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} · ${time}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${time}`;
}

// Calendar-day bucket key for the "Group by day" table toggle.
export function dayKey(ts) {
  return new Date(startOfDay(ts)).toDateString();
}

// Day-only counterpart to formatRunWhen, for the group-by-day section header.
export function formatDayLabel(ts, now = Date.now()) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '—';
  const dayDiff = Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS);
  if (dayDiff === 0) return 'Today';
  if (dayDiff === 1) return 'Yesterday';
  const d = new Date(ts);
  if (dayDiff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: dayDiff > 300 ? 'numeric' : undefined });
}

export function runsRows(runs = [], filters = {}, now = Date.now()) {
  const { window, kind, skill, repo, verdict } = filters;
  const rows = runs
    .filter((r) => withinWindow(r, window, now)
      && matchesKind(r, kind)
      && matchesSkill(r, skill)
      && matchesRepo(r, repo)
      && matchesVerdict(r, verdict))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

  const tally = rows.reduce((acc, r) => ({
    count: acc.count + 1,
    totalDurationMs: acc.totalDurationMs + (r.durationMs ?? 0),
    totalCostUsd: acc.totalCostUsd + (r.costUsd ?? 0),
  }), { count: 0, totalDurationMs: 0, totalCostUsd: 0 });

  return { rows, tally };
}
