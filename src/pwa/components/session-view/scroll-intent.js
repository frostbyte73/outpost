// Transcript scroll intent, per session and independent of any mount.
// `stickyBottom` defaults true so a freshly-mounted tab lands at the newest
// message. When the user scrolls up, we flip to false and remember their
// absolute scrollTop; when they come back within NEAR_BOTTOM_PX of the bottom,
// we flip back. Survives unmount/remount so tab switches restore whichever mode
// the user last chose.

const NEAR_BOTTOM_PX = 40;

const intents = new Map();

export function getIntent(sessionId) {
  let it = intents.get(sessionId);
  if (!it) { it = { stickyBottom: true, savedScrollTop: 0 }; intents.set(sessionId, it); }
  return it;
}

// A scrollTop we assign ourselves fires a scroll event the listener can't tell
// from the user's. This used to be handled by ignoring every event for 80ms
// after a write — but a streaming session repaints every frame, so the window
// never closed and the user's own scrolls were swallowed for the length of the
// turn: intent stayed pinned to the bottom, the next frame re-asserted it, and
// scrolling up became a jitter loop. Match on the value the browser actually
// took instead, so exactly one event is ignored and anything else is the user.
export function createScrollIntent(sessionId) {
  let ownTop = null;
  return {
    get intent() { return getIntent(sessionId); },

    noteOwnWrite(top) { ownTop = top; },

    // Returns true when the event came from the user (intent may have changed).
    handleScroll({ scrollTop, scrollHeight, clientHeight }) {
      const own = ownTop;
      ownTop = null;
      if (own !== null && Math.abs(scrollTop - own) <= 1) return false;
      const intent = getIntent(sessionId);
      if (scrollHeight - scrollTop - clientHeight < NEAR_BOTTOM_PX) {
        intent.stickyBottom = true;
      } else {
        intent.stickyBottom = false;
        intent.savedScrollTop = scrollTop;
      }
      return true;
    },
  };
}

// Single door for every programmatic scroll of a transcript, so the element's
// tracker always learns the clamped value the browser settled on — writing past
// the bottom of content that hasn't laid out yet lands at 0, and the resulting
// event has to match that, not what we asked for.
export function scrollTranscriptTo(t, top) {
  t.scrollTop = top;
  t.__ovScroll?.noteOwnWrite(t.scrollTop);
}
