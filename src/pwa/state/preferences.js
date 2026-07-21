import { preferencesApi } from '../net/preferences.js';

// Daemon-backed preferences sync (Spec A). This module owns neither store state
// nor the localStorage mirror — each store keeps writing its own mirror for
// instant, flash-free paint, and registers here how to (a) apply a daemon value
// without re-pushing it, and (b) read its current value for first-run seeding.
const appliers = new Map(); // key -> (value) => void
const readers = new Map();  // key -> () => value

export function register({ key, apply, current }) {
  appliers.set(key, apply);
  readers.set(key, current);
}

let pending = {};
let timer = null;
const DEBOUNCE_MS = 400;

// Record a user-initiated preference change; coalesce into one debounced PATCH.
export function push(key, value) {
  pending[key] = value;
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, DEBOUNCE_MS);
}

async function flush() {
  timer = null;
  const patch = pending;
  pending = {};
  if (!Object.keys(patch).length) return;
  try { await preferencesApi.patch(patch); }
  catch { /* offline — the mirror already holds the local value */ }
}

// Boot reconcile: daemon wins for keys it has; seed it from local for keys it
// lacks (first run / existing user migrating off localStorage).
export async function hydrate() {
  let remote;
  try { remote = await preferencesApi.get(); }
  catch { return; } // offline — keep whatever the mirror loaded synchronously
  const seed = {};
  for (const [key, apply] of appliers) {
    if (Object.prototype.hasOwnProperty.call(remote, key)) {
      apply(remote[key]); // daemon wins; apply updates store + mirror, no push
    } else {
      const cur = readers.get(key)?.();
      if (cur !== undefined) seed[key] = cur;
    }
  }
  if (Object.keys(seed).length) {
    try { await preferencesApi.patch(seed); }
    catch { /* offline — reseed on next hydrate */ }
  }
}
