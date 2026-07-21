// Shared todo-list logic used by both the mobile/legacy sheet (todos-sheet.js)
// and the desktop Sessions right rail (sessions-surface/rail.js). Pure data
// shaping only — each caller owns its own markup, since the sheet and rail
// render genuinely different card shapes (D2: extract the shared piece,
// don't force one markup on two visually-diverged surfaces).
//
// Provenance (`producedBy` / `createdAt` / `updatedAt`) is additive on the todo
// record — stamped by state/subagents.js's applyTaskUse, tolerant of older
// records that predate the field (they just render without a meta line).

export function sortedTodoEntries(todos) {
  return [...todos.entries()].sort((a, b) => {
    const ai = parseInt(a[0], 10), bi = parseInt(b[0], 10);
    if (Number.isFinite(ai) && Number.isFinite(bi)) return ai - bi;
    return String(a[0]).localeCompare(String(b[0]));
  });
}

// Three-way partition shared by the sheet's section grouping and the rail's
// visual-weight grouping. `all` excludes soft-deleted entries; `completed` is
// newest-first (opposite of dispatch order) so the most recently finished item
// reads at the top.
export function partitionTodos(todos) {
  const all = sortedTodoEntries(todos).filter(([, t]) => t.status !== 'deleted');
  const inProgress = all.filter(([, t]) => t.status === 'in_progress');
  const pending = all.filter(([, t]) => t.status === 'pending');
  const completed = all.filter(([, t]) => t.status === 'completed').reverse();
  return { all, inProgress, pending, completed };
}

function fmtElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${String(rs).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${String(rm).padStart(2, '0')}m`;
}

// One-line provenance/timing string for a todo record, or null if there's
// nothing worth showing (e.g. a pending item with no attribution yet).
// Best-effort: "producedBy" is stamped from whatever tool/subagent was active
// at the moment the todo's status last flipped — an approximation, not a
// guaranteed causal link, since the todo protocol itself carries no explicit
// attribution field.
export function todoProvenanceText(t) {
  const parts = [];
  if (t.status === 'completed' && t.createdAt && t.updatedAt && t.updatedAt > t.createdAt) {
    const d = fmtElapsed(t.updatedAt - t.createdAt);
    if (d) parts.push(d);
  }
  const via = t.producedBy;
  if (via?.toolName) parts.push(`via ${via.toolName}`);
  else if (via?.agentType) parts.push(`${via.agentType} agent`);
  else if (t.status === 'in_progress') parts.push('running');
  else if (t.status === 'pending') parts.push('queued');
  return parts.length ? parts.join(' · ') : null;
}
