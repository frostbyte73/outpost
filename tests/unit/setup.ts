// Node 25 ships a native localStorage stub that vitest-jsdom doesn't override because
// the stub's presence in global prevents the jsdom copy from being installed. Patch it
// with a Map-backed implementation so jsdom tests can use localStorage normally.
if (typeof localStorage === 'undefined' || typeof localStorage.clear !== 'function') {
  const store = new Map<string, string>();
  const ls: Storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    get length() { return store.size; },
    key: (i: number) => [...store.keys()][i] ?? null,
  };
  Object.defineProperty(globalThis, 'localStorage', { value: ls, writable: true, configurable: true });
}
