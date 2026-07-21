export function createStore(initial) {
  let state = initial;
  const subs = new Set();

  function get() {
    return state;
  }

  function set(updater) {
    const next = typeof updater === 'function' ? updater(state) : updater;
    if (next === state) return;
    state = next;
    for (const fn of subs) fn(state);
  }

  function subscribe(fn) {
    subs.add(fn);
    return () => { subs.delete(fn); };
  }

  return { get, set, subscribe };
}
