import { createStore } from './create-store.js';

// Bumps a session's cockpit order the instant dc sends, before the daemon's next session-list read.
const store = createStore(new Map());

export const engagement = {
  get: store.get,
  subscribe: store.subscribe,
  markSession(id) { store.set((m) => new Map(m).set(id, Date.now())); },
};
