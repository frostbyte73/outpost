// Highest priority first; whether a process happens to be alive never enters into it.
export function sessionState({ hasApproval, working, lastReplyAt, seenAt, unreadTracked = true }) {
  if (hasApproval) return 'approval';
  if (unreadTracked && lastReplyAt != null && lastReplyAt > (seenAt ?? 0)) return 'unread';
  if (working) return 'thinking';
  return 'idle';
}

// Merges a session record from GET /api/sessions with this tab's live slice and the activity feed.
export function sessionSignals(s, slice, activity) {
  const live = activity?.get(s.id);
  const replies = [live?.lastReplyAt, s.lastReplyAt].filter((t) => t != null);
  return {
    working: Boolean(slice?.thinking || (live?.working ?? s.working)),
    lastReplyAt: replies.length ? Math.max(...replies) : null,
    seenAt: Math.max(live?.seenAt ?? 0, s.seenAt ?? 0),
  };
}
