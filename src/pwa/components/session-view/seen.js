// Reports a session seen when its view becomes visible, and again whenever a reply lands while it stays visible.
export function createSeenReporter({ sessionId, isVisible, activityFor, postSeen, applySeen }) {
  let inFlight = false;

  // A failure isn't retried until the next reply or visibility change, so a daemon that's down can't spin it.
  const post = () => {
    inFlight = true;
    Promise.resolve(postSeen(sessionId)).then(
      (seenAt) => { inFlight = false; applySeen(sessionId, seenAt); onActivity(); },
      () => { inFlight = false; },
    );
  };

  function onActivity() {
    if (inFlight || !isVisible()) return;
    const entry = activityFor(sessionId);
    if (entry?.lastReplyAt != null && entry.lastReplyAt > (entry.seenAt ?? 0)) post();
  }

  return {
    onVisible() {
      if (!inFlight && isVisible()) post();
    },
    onActivity,
  };
}
