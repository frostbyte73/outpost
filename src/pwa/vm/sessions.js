// Sessions-list view-model: flattens the per-project session records into the
// flat Running/Idle/Recent grouping the redesign's list column needs, layered on
// top of session-filter.js's archived-handling (not a replacement for it).
//
// "Recent" here means the archived tail revealed by the show-archived toggle —
// distinct from "Idle" (non-archived, currently not running).

import { partitionSessions } from '../session-filter.js';
import { formatDuration } from '../utils/formatting.js';

// One definition of "skill session" shared by the Skill tab and the per-card
// skill badge: sessions running a slash skill (derived skillLabel) plus the
// backend-tagged skill/action edit kinds. Free-form is the complement.
function isSkillSession(item) {
  return item.skillLabel != null || item.kind === 'skill-edit' || item.kind === 'action-edit';
}

function matchesTab(item, tab) {
  if (tab === 'active') return item.runState === 'foreground' || item.runState === 'background';
  if (tab === 'skill') return isSkillSession(item);
  if (tab === 'free-form') return (!item.kind || item.kind === 'normal') && item.skillLabel == null;
  return true;
}

function matchesFilter(item, filter) {
  if (!filter) return true;
  const q = filter.toLowerCase();
  return (item.title ?? '').toLowerCase().includes(q) || (item.cwd ?? '').toLowerCase().includes(q);
}

function bucketOf(item) {
  if (item.archived) return 'recent';
  if (item.runState === 'foreground' || item.runState === 'background') return 'running';
  return 'idle';
}

const byRecency = (a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0);

export function sessionGroups({
  projects = [],
  sessionsById = new Map(),
  filter = '',
  tab = 'all',
  showArchived = false,
  subagentCountBySession = new Map(),
  approvalSessionIds = new Set(),
  previewBySession = new Map(),
  skillLabelBySession = new Map(),
} = {}) {
  const flat = [];
  for (const p of projects) {
    const { visible } = partitionSessions(p.sessions ?? [], 0, 0, { showArchived });
    for (const s of visible) {
      const runtime = sessionsById.get(s.id);
      flat.push({
        id: s.id,
        title: s.title,
        cwd: p.cwd,
        lastModified: s.lastModified,
        archived: !!s.archived,
        kind: s.kind ?? 'normal',
        worktreePath: s.worktreePath,
        worktreeBranch: s.worktreeBranch,
        // Live slice wins (this tab has direct WS signals); otherwise fall
        // back to the daemon-reported liveness on the session row so running
        // sessions survive a reload. Server 'foreground' means "mounted in
        // some client", not this tab — treat as background here.
        runState: runtime?.runState
          ?? (s.runState === 'foreground' || s.runState === 'background' ? 'background' : 'inactive'),
        subagentCount: subagentCountBySession.get(s.id) ?? 0,
        hasApproval: approvalSessionIds.has(s.id),
        preview: previewBySession.get(s.id) ?? null,
        skillLabel: skillLabelBySession.get(s.id) ?? null,
      });
    }
  }

  const filtered = flat.filter((item) => matchesTab(item, tab) && matchesFilter(item, filter));

  const running = [];
  const idle = [];
  const recent = [];
  for (const item of filtered) {
    const bucket = bucketOf(item);
    (bucket === 'running' ? running : bucket === 'idle' ? idle : recent).push(item);
  }
  running.sort(byRecency);
  idle.sort(byRecency);
  recent.sort(byRecency);

  return { running, idle, recent };
}

// Skill badge + last-turn preview, derived from a live transcript slice.
// Shared by the list column's card preview and the session header's badge —
// both need the same "what skill is this session running" heuristic (the
// first user turn starting with `/`), so it lives here rather than being
// forked per caller. See list.js's module doc for the known limitation: this
// only works for sessions this browser session has already loaded a
// transcript for.
export function deriveSkillLabel(transcript) {
  const firstUser = (transcript ?? []).find((m) => m.role === 'user' && typeof m.text === 'string' && m.text.trim());
  if (!firstUser) return null;
  const trimmed = firstUser.text.trim();
  return trimmed.startsWith('/') ? trimmed.split(/\s/)[0] : null;
}

export function deriveLastTurnPreview(transcript) {
  const t = transcript ?? [];
  for (let i = t.length - 1; i >= 0; i -= 1) {
    const m = t[i];
    if ((m.role === 'assistant' || m.role === 'user') && typeof m.text === 'string' && m.text.trim()) {
      return m.text.trim();
    }
  }
  return null;
}

// "4m 08s" / "1h 02m" elapsed-time formatting shared by the list column's
// running-duration badge and the session header's live-pulse duration.
// Thin wrapper over the canonical utils/formatting.js duration (kept exported
// under this name so existing callers don't churn); '' fallback for inline use.
export function fmtElapsedDuration(ms) {
  return formatDuration(ms) ?? '';
}
