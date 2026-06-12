// Pure session-list partitioning. Used by the PWA's project section body to decide
// which session rows to render vs. hide behind the "Load more" button.
//
// Rule (mirrors docs/superpowers/specs/2026-06-12-session-list-filtering-design.md):
//   - Sessions whose index < 3 are always visible (top-3 carve-out).
//   - Sessions with an active worktree (worktreePath set AND !archived) are always
//     visible, regardless of position.
//   - Of the remaining sessions, those modified within the last 7 days are visible.
//   - Older remaining sessions form the "hidden pool". The first `extraRevealed` of
//     them (newest-first, matching the input order) are revealed; the rest stay hidden.
//
// Input invariant: `sessions` is sorted newest-first by lastModified, the same shape
// that listProjects() produces server-side.

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ALWAYS_SHOW_TOP = 3;

export function partitionSessions(sessions, extraRevealed, nowMs) {
  const visibleIds = new Set();
  const hiddenPool = [];
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const hasActiveWorktree = !!s.worktreePath && !s.archived;
    const inTopThree = i < ALWAYS_SHOW_TOP;
    const withinAgeWindow = (nowMs - s.lastModified) <= WINDOW_MS;
    if (inTopThree || hasActiveWorktree || withinAgeWindow) {
      visibleIds.add(s.id);
    } else {
      hiddenPool.push(s);
    }
  }
  const revealCount = Math.min(Math.max(0, extraRevealed | 0), hiddenPool.length);
  for (let i = 0; i < revealCount; i++) visibleIds.add(hiddenPool[i].id);
  const visible = sessions.filter((s) => visibleIds.has(s.id));
  const hiddenRemaining = hiddenPool.length - revealCount;
  return { visible, hiddenRemaining };
}
