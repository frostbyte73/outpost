import { createStore } from './create-store.js';

// Per-session { working, lastReplyAt, seenAt }, kept live by the daemon's session_activity notifications.
const store = createStore(new Map());

const FIELDS = ['working', 'lastReplyAt', 'seenAt'];

export const sessionActivity = {
  get: store.get,
  subscribe: store.subscribe,
  seed(projects) {
    store.set((m) => {
      const next = new Map(m);
      for (const p of projects ?? []) {
        for (const s of p.sessions ?? []) {
          const prev = m.get(s.id);
          next.set(s.id, {
            working: !!s.working,
            lastReplyAt: latest(prev?.lastReplyAt, s.lastReplyAt),
            seenAt: latest(prev?.seenAt, s.seenAt) ?? 0,
          });
        }
      }
      return next;
    });
  },
  workingCount() {
    let n = 0;
    for (const a of store.get().values()) if (a.working) n++;
    return n;
  },
  apply(msg) {
    if (!msg?.sessionId) return;
    store.set((m) => {
      const entry = { working: false, lastReplyAt: null, seenAt: 0, ...m.get(msg.sessionId) };
      for (const f of FIELDS) if (msg[f] !== undefined) entry[f] = msg[f];
      return new Map(m).set(msg.sessionId, entry);
    });
  },
};

// A list load can be older than a notification already applied; timestamps only move forward.
function latest(a, b) {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.max(a, b);
}
