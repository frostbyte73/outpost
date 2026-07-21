import { createStore } from './create-store.js';

// Connection state for the two WebSocket channels the client keeps open:
//   session — one or more `/ws/sessions/<id>` sockets, managed by session-ws.js
//   notify  — the singleton `/ws/notifications` socket, managed by notify-ws.js
//
// Each channel publishes one of:
//   'idle'         — no attempt in flight (e.g., no session mounted yet)
//   'connected'    — socket open
//   'reconnecting' — closed and backing off, still under retry threshold
//   'failed'       — closed and past retry threshold; UI surfaces a banner
//
// updateConnIndicator in app.js reads both fields to set data-conn on <html>
// and to decide whether to show the disconnect banner. session-view reads the
// session field directly for its per-tab conn banner.

const initial = { session: 'idle', notify: 'idle' };

const store = createStore(initial);

export const conn = {
  get: store.get,
  subscribe: store.subscribe,
  setSession(next) {
    store.set((s) => (s.session === next ? s : { ...s, session: next }));
  },
  setNotify(next) {
    store.set((s) => (s.notify === next ? s : { ...s, notify: next }));
  },
};
