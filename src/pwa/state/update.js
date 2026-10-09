import { createStore } from './create-store.js';

const store = createStore({ status: null, busy: false, error: null });
let loading = null;

async function call(path, init) {
  store.set((s) => ({ ...s, busy: true, error: null }));
  try {
    const res = await fetch(path, init);
    if (!res.ok) throw new Error(await res.text() || `update api ${res.status}`);
    const status = await res.json();
    store.set((s) => ({ ...s, status, busy: false }));
  } catch (e) {
    store.set((s) => ({ ...s, busy: false, error: e.message }));
  }
}

export function updateAvailable(status) {
  return !!status && status.behind > 0 && !status.blocked && status.phase !== 'restart-pending';
}

export const updateStore = {
  get: store.get,
  subscribe: store.subscribe,

  load() { return call('/api/update'); },
  // Headers repaint constantly; later changes arrive over WS, so one fetch per page load does.
  ensureLoaded() {
    loading ??= call('/api/update');
    return loading;
  },
  check() { return call('/api/update/check', { method: 'POST' }); },
  apply() { return call('/api/update/apply', { method: 'POST' }); },
  setAuto(enabled) {
    return call('/api/update/auto', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
  },

  applyWsEvent(status) {
    if (status) store.set((s) => ({ ...s, status }));
  },
};
