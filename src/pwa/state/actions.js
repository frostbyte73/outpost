import { createStore } from './create-store.js';
import { actionsApi } from '../net/actions.js';

const initial = {
  // On-disk action registry (with merged allowlist) — what the Actions tab renders.
  actions: [],
  // Action catalog from ActionRegistry — what the plan editor's typed-action picker reads.
  catalog: [],
  skills: [],
  edits: [],
  // Improver revisions a passing eval installed in the last day — the cockpit's cleared tail.
  autoApplied: [],
  denials: {},
  // sessionId → { verb, at } — live "doing X right now" indicator for the inline
  // action-builder edit card. Updated by action_edit_activity notifications.
  activity: new Map(),
  loaded: false,
  loading: false,
  err: null,
};

const store = createStore(initial);

// Maps a canonical tool name (src/runtime/tools.ts) to the verb shown next to the glowy ellipses.
function verbForTool(tool) {
  if (!tool) return 'thinking';
  if (tool === 'shell') return 'bashing';
  if (tool === 'file_write') return 'writing';
  if (tool === 'file_edit' || tool === 'file_multi_edit' || tool === 'notebook_edit') return 'editing';
  if (tool === 'file_read' || tool === 'file_glob' || tool === 'file_grep' || tool === 'file_list' || tool === 'notebook_read') return 'reading';
  if (tool === 'web_fetch' || tool === 'web_search') return 'searching';
  if (tool.startsWith('mcp:')) return 'calling';
  return 'thinking';
}

export const actions = {
  get: store.get,
  subscribe: store.subscribe,
  async load() {
    store.set((s) => ({ ...s, loading: true, err: null }));
    try {
      const j = await actionsApi.list();
      store.set((s) => ({
        ...s,
        actions: j.actions ?? [],
        catalog: j.catalog ?? [],
        skills: j.skills ?? [],
        edits: j.edits ?? [],
        autoApplied: j.autoApplied ?? [],
        denials: j.denials ?? {},
        loaded: true,
        loading: false,
        err: null,
      }));
    } catch (e) {
      store.set((s) => ({ ...s, loading: false, err: String(e) }));
    }
  },
  pushActivity(sessionId, tool, at) {
    if (!sessionId) return;
    const verb = verbForTool(tool);
    store.set((s) => {
      const next = new Map(s.activity);
      next.set(sessionId, { verb, at: at ?? Date.now() });
      return { ...s, activity: next };
    });
  },
};

export function editFor(state, actionName) {
  return (state.edits ?? []).find((e) => e.actionName === actionName);
}

// Lookup an in-flight action-edit by its builder session id — the resolver for
// the `new:<sessionId>` skills-surface selection used by the new-action WIP view.
export function findEditBySession(state, sessionId) {
  return (state.edits ?? []).find((e) => e.sessionId === sessionId) ?? null;
}
