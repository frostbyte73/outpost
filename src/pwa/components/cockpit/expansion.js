import { createStore } from '../../state/create-store.js';

const store = createStore(new Map());

export const expansion = {
  get: store.get,
  subscribe: store.subscribe,
  open(key, mode) { store.set((m) => new Map(m).set(key, mode)); },
  close(key) { store.set((m) => { if (!m.has(key)) return m; const n = new Map(m); n.delete(key); return n; }); },
  toggle(key, mode) { if (store.get().get(key) === mode) this.close(key); else this.open(key, mode); },
};
