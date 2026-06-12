// Pure session-list partitioning. The daemon already stamps `archived: true` on any
// session whose lastModified is past the 7d activity window (see
// AUTO_ARCHIVE_WINDOW_MS in session-store.ts), so this filter only needs to honour
// the archived flag — there's no separate "old but not yet archived" bucket to manage.
//
// Rule:
//   - Archived sessions are excluded by default. They reappear (in their natural
//     newest-first slot) only when `showArchived` is true.
//   - Non-archived sessions are always visible. The top-3 / active-worktree carve-outs
//     of older rules are now redundant (anything that would have triggered them is
//     either still ≤7d old, or has a live worktree which keeps it non-archived).
//
// Input invariant: `sessions` is sorted newest-first by lastModified.

export function partitionSessions(sessions, _extraRevealed, _nowMs, opts) {
  const showArchived = !!(opts && opts.showArchived);
  const visible = [];
  let archivedCount = 0;
  for (const s of sessions) {
    if (s.archived) {
      archivedCount++;
      if (showArchived) visible.push(s);
    } else {
      visible.push(s);
    }
  }
  return { visible, hiddenRemaining: 0, archivedCount };
}
