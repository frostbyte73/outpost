import { createStore } from './create-store.js';
import { runsApi } from '../net/runs.js';

const EMPTY_TALLY = { count: 0, totalDurationMs: 0, totalCostUsd: 0 };
let pendingFilter = null;

const store = createStore({
  runs: [],
  tally: EMPTY_TALLY,
  loading: false,
  filters: {},
  err: null,
});

export const runs = {
  get: store.get,
  subscribe: store.subscribe,

  async load(filters) {
    const nextFilters = filters ?? store.get().filters;
    store.set((s) => ({ ...s, loading: true, err: null, filters: nextFilters }));
    try {
      const data = await runsApi.list(nextFilters);
      store.set((s) => ({
        ...s,
        runs: Array.isArray(data?.runs) ? data.runs : [],
        tally: data?.tally ?? EMPTY_TALLY,
        loading: false,
      }));
    } catch (e) {
      store.set((s) => ({ ...s, loading: false, err: e.message }));
    }
  },

  // One-shot filter handoff for cross-surface links (e.g. a skill detail's
  // "View all N runs" jumping to the Runs history surface pre-filtered to that
  // skill) — same transient side-channel shape as state/nav.js's session hints.
  // Not part of the persisted store shape; read-and-clear by the runs view on mount.
  setPendingFilter(patch) { pendingFilter = patch ?? null; },
  consumePendingFilter() {
    const p = pendingFilter;
    pendingFilter = null;
    return p;
  },

  // `run_appended` WS event (src/routes/runs.ts / daemon.ts's onRunAppended). Prepends
  // rather than refetching; a run whose kind doesn't match the active filter is dropped
  // rather than silently shown in a filtered view.
  applyWsAppend(run) {
    if (!run || typeof run.id !== 'string') return;
    store.set((s) => {
      if (s.runs.some((r) => r.id === run.id)) return s;
      if (s.filters.kind && run.kind !== s.filters.kind) return s;
      return {
        ...s,
        runs: [run, ...s.runs],
        tally: {
          count: s.tally.count + 1,
          totalDurationMs: s.tally.totalDurationMs + (run.durationMs ?? 0),
          totalCostUsd: s.tally.totalCostUsd + (run.costUsd ?? 0),
        },
      };
    });
  },
};
