import { createStore } from './create-store.js';

const initial = {
  prs: [],
  lastSyncAt: null,
  lastError: null,
  loading: false,
  refreshing: false,
};

const store = createStore(initial);

async function fetchJson(path, init) {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`user-prs api ${res.status}`);
  return res.json();
}

export const userPrs = {
  get: store.get,
  subscribe: store.subscribe,

  async load() {
    store.set((s) => ({ ...s, loading: true }));
    try {
      const data = await fetchJson('/api/user-prs');
      store.set((s) => ({
        ...s,
        prs: Array.isArray(data?.prs) ? data.prs : [],
        lastSyncAt: data?.lastSyncAt ?? null,
        lastError: data?.lastError ?? null,
        loading: false,
      }));
    } catch (e) {
      store.set((s) => ({ ...s, loading: false, lastError: e.message }));
    }
  },

  async refresh() {
    store.set((s) => ({ ...s, refreshing: true }));
    try {
      const data = await fetchJson('/api/user-prs/refresh', { method: 'POST' });
      store.set((s) => ({
        ...s,
        prs: Array.isArray(data?.prs) ? data.prs : s.prs,
        lastSyncAt: data?.lastSyncAt ?? s.lastSyncAt,
        lastError: data?.lastError ?? null,
        refreshing: false,
      }));
    } catch (e) {
      store.set((s) => ({ ...s, refreshing: false, lastError: e.message }));
    }
  },

  applyWsEvent(snapshot) {
    if (!snapshot) return;
    store.set((s) => ({
      ...s,
      prs: Array.isArray(snapshot.prs) ? snapshot.prs : s.prs,
      lastSyncAt: snapshot.lastSyncAt ?? s.lastSyncAt,
      lastError: snapshot.lastError ?? null,
    }));
  },
};
