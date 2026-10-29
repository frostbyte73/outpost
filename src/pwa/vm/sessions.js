// Sessions-list view-model: flattens the per-project session records into the
// flat Sessions/Actions/Idle/Recent grouping the redesign's list column needs,
// layered on top of session-filter.js's archived-handling (not a replacement
// for it).
//
// The two live groups are every non-idle session (see session-state.js) split by who
// is driving it — a person ("Sessions") or Outpost running an action on their behalf
// ("Actions"). "Idle" is the rest, either class; "Recent" is the archived tail
// revealed by the show-archived toggle.

import { partitionSessions } from '../session-filter.js';
import { formatDuration } from '../utils/formatting.js';
import { sessionState, sessionSignals } from './session-state.js';

// "Action" = a session Outpost spawned to run a locked-down action on the user's
// behalf (orchestrator, step, or action/skill edit), stamped server-side as
// sessionClass:'action'. A plain interactive session is the complement. The
// backend edit kinds are folded in for older sessions predating sessionClass.
function isActionSession(item) {
  return item.sessionClass === 'action' || item.kind === 'skill-edit' || item.kind === 'action-edit';
}

function matchesTab(item, tab) {
  if (tab === 'active') return item.state !== 'idle';
  if (tab === 'action') return isActionSession(item);
  if (tab === 'session') return !isActionSession(item);
  return true;
}

function matchesFilter(item, filter) {
  if (!filter) return true;
  const q = filter.toLowerCase();
  return (item.title ?? '').toLowerCase().includes(q) || (item.cwd ?? '').toLowerCase().includes(q);
}

function bucketOf(item) {
  if (item.archived) return 'recent';
  if (item.state === 'idle') return 'idle';
  return isActionSession(item) ? 'actions' : 'sessions';
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
  activity = new Map(),
} = {}) {
  const flat = [];
  for (const p of projects) {
    const { visible } = partitionSessions(p.sessions ?? [], 0, 0, { showArchived });
    for (const s of visible) {
      const hasApproval = approvalSessionIds.has(s.id);
      const unreadTracked = !isActionSession(s);
      flat.push({
        id: s.id,
        title: s.title,
        cwd: p.cwd,
        lastModified: s.lastModified,
        archived: !!s.archived,
        kind: s.kind ?? 'normal',
        sessionClass: s.sessionClass ?? 'session',
        actionLabel: s.actionLabel ?? null,
        worktreePath: s.worktreePath,
        worktreeBranch: s.worktreeBranch,
        state: sessionState({ hasApproval, unreadTracked, ...sessionSignals(s, sessionsById.get(s.id), activity) }),
        subagentCount: subagentCountBySession.get(s.id) ?? 0,
        hasApproval,
        preview: previewBySession.get(s.id) ?? null,
      });
    }
  }

  const filtered = flat.filter((item) => matchesTab(item, tab) && matchesFilter(item, filter));

  const groups = { sessions: [], actions: [], idle: [], recent: [] };
  for (const item of filtered) groups[bucketOf(item)].push(item);
  for (const group of Object.values(groups)) group.sort(byRecency);
  return groups;
}

// First user turn's slash command, if any (e.g. "/oncall"). The sessions-list
// badge no longer uses this — it reads the server-stamped actionLabel — but the
// desktop + mobile session headers still fall back to it as a title when a
// session's derived title is just its id prefix.
export function deriveSkillLabel(transcript) {
  const firstUser = (transcript ?? []).find((m) => m.role === 'user' && typeof m.text === 'string' && m.text.trim());
  if (!firstUser) return null;
  const trimmed = firstUser.text.trim();
  return trimmed.startsWith('/') ? trimmed.split(/\s/)[0] : null;
}

// Last-turn preview, derived from whatever transcript slice this browser session
// has already loaded (see list.js's module doc for the "only for opened sessions"
// limitation).
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
