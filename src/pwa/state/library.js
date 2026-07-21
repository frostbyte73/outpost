import { createStore } from './create-store.js';
import { actionsApi } from '../net/actions.js';

// Skills-library detail state: the permission-groups catalog (static-ish,
// loaded once) and a per-skill journal-entries cache (loaded lazily per
// selection, since fetching all 40+ actions' journals up front is wasted work).

const store = createStore({
  permissionGroups: [],
  permissionGroupsLoaded: false,
  journalByAction: new Map(),
  journalLoading: new Set(),
});

export const library = {
  get: store.get,
  subscribe: store.subscribe,

  async loadPermissionGroups() {
    if (store.get().permissionGroupsLoaded) return;
    try {
      const data = await actionsApi.permissionGroups();
      store.set((s) => ({ ...s, permissionGroups: data?.groups ?? [], permissionGroupsLoaded: true }));
    } catch {
      // Detail view renders group names without descriptions/counts on failure.
    }
  },

  async loadJournal(name, limit = 8) {
    if (!name) return;
    const s = store.get();
    if (s.journalByAction.has(name) || s.journalLoading.has(name)) return;
    store.set((cur) => ({ ...cur, journalLoading: new Set(cur.journalLoading).add(name) }));
    try {
      const data = await actionsApi.journal(name, limit);
      store.set((cur) => {
        const journalByAction = new Map(cur.journalByAction);
        journalByAction.set(name, data?.entries ?? []);
        const journalLoading = new Set(cur.journalLoading);
        journalLoading.delete(name);
        return { ...cur, journalByAction, journalLoading };
      });
    } catch {
      store.set((cur) => {
        const journalLoading = new Set(cur.journalLoading);
        journalLoading.delete(name);
        return { ...cur, journalLoading };
      });
    }
  },
};

export function permissionGroupByName(state, name) {
  return (state.permissionGroups ?? []).find((g) => g.name === name) ?? null;
}
