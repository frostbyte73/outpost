import { createStore } from './create-store.js';
import { metaApi } from '../net/meta.js';
import { mcpNeedsAttention } from '../vm/settings.js';

// Backs the Settings > Permissions and Settings > MCP connections sections.
// Groups and allowlist rules change rarely, so the load* entry points are
// cached for the tab's lifetime; MCP status is a live probe and reloads every
// time (mount, and the section's refresh button).
//
// The Permissions page edits groups and rules, so it needs the uncached
// reload* pair: a save repaints from what the server actually persisted, never
// from a local guess at what the PUT did — the daemon normalizes the group and
// can refuse part of an edit, so optimistic state is a lie waiting to happen.

const store = createStore({
  groups: [],
  rules: [],
  mcpServers: [],
  pendingDenials: [],
  claudeAuth: null,
  groupsLoaded: false,
  rulesLoaded: false,
  mcpLoaded: false,
  mcpLoading: false,
  pendingLoaded: false,
  pendingLoading: false,
  // Per-resource load errors. A shared `err` cannot answer the question each panel asks — "did
  // MY fetch fail?" — and a panel that can't answer it renders its spinner forever.
  groupsErr: null,
  rulesErr: null,
  pendingErr: null,
  err: null,
});

export const grantsStore = {
  get: store.get,
  subscribe: store.subscribe,

  async reloadGroups() {
    try {
      const data = await metaApi.permissionGroups();
      store.set((s) => ({ ...s, groups: Array.isArray(data?.groups) ? data.groups : [], groupsLoaded: true, groupsErr: null }));
    } catch (e) {
      store.set((s) => ({ ...s, err: e.message, groupsErr: e.message }));
    }
  },

  async reloadRules() {
    try {
      const data = await metaApi.allowlistRules();
      store.set((s) => ({ ...s, rules: Array.isArray(data?.rules) ? data.rules : [], rulesLoaded: true, rulesErr: null }));
    } catch (e) {
      store.set((s) => ({ ...s, err: e.message, rulesErr: e.message }));
    }
  },

  async loadGroups() {
    if (store.get().groupsLoaded) return;
    await this.reloadGroups();
  },

  async loadRules() {
    if (store.get().rulesLoaded) return;
    await this.reloadRules();
  },

  async loadMcp() {
    store.set((s) => ({ ...s, mcpLoading: true }));
    try {
      const data = await metaApi.mcpStatus();
      store.set((s) => ({ ...s, mcpServers: Array.isArray(data?.servers) ? data.servers : [], mcpLoaded: true, mcpLoading: false }));
    } catch (e) {
      store.set((s) => ({ ...s, err: e.message, mcpLoading: false }));
    }
  },

  // Unlike groups/rules, a verdict POST always reloads this from the server rather than
  // patching local state (the Pending panel repaints from what the daemon actually resolved,
  // same discipline as commit() in groups.js) — so this is called unconditionally, not just
  // once per tab.
  async reloadPending() {
    store.set((s) => ({ ...s, pendingLoading: true }));
    try {
      const data = await metaApi.pending();
      store.set((s) => ({
        ...s,
        pendingDenials: Array.isArray(data?.denials) ? data.denials : [],
        pendingLoaded: true,
        pendingLoading: false,
        pendingErr: null,
      }));
    } catch (e) {
      store.set((s) => ({ ...s, err: e.message, pendingErr: e.message, pendingLoading: false }));
    }
  },

  async loadPending() {
    if (store.get().pendingLoaded) return;
    await this.reloadPending();
  },

  // Always re-fetched rather than cached: the answer changes underneath the tab (a credential
  // lapses, a login lands on another device) and it is the one panel that has to be right at
  // the moment it is read.
  async loadClaudeAuth() {
    try {
      const data = await metaApi.claudeAuth();
      store.set((s) => ({ ...s, claudeAuth: data ?? null }));
    } catch (e) {
      store.set((s) => ({ ...s, err: e.message }));
    }
  },

  async ensurePermissionsLoaded() {
    await Promise.all([this.loadGroups(), this.loadRules()]);
  },
  async ensureMcpLoaded() {
    if (store.get().mcpLoaded || store.get().mcpLoading) return;
    await this.loadMcp();
  },
};

// Cross-section warn-dot signal: the MCP connections nav item lights up if any configured
// server is unreachable, or if an OAuth credential has lapsed or is about to. The second half
// is the point of surfacing expiry at all — a token that quietly expires is otherwise
// discovered by a job failing mid-step. Consumed by vm/settings.js's settingsSections() rather
// than computed inline there so the view-model stays a pure function of derived booleans.
export function mcpHasWarning(state) {
  return (state.mcpServers ?? []).some((s) => s.status === 'unreachable')
    || mcpNeedsAttention(state.mcpServers ?? []);
}

// Same signal for Claude's own account. `failedSince` is the one that matters in practice: the
// token refreshes itself every few hours, so a lapse shows up as a session that couldn't
// start, never as an expiry anyone saw coming.
export function claudeAuthHasWarning(state) {
  const auth = state.claudeAuth;
  if (!auth) return false;
  if (auth.failedSince) return true;
  // An unreadable probe is not a lapse — see claudeAccountRow.
  return !auth.account?.error && auth.account?.loggedIn === false;
}

// Same signal, denials half: the Permissions nav item lights up while an unresolved denial is
// waiting on a verdict — or while the fetch that would have found one failed, since a page that
// cannot list denials is exactly when the user needs sending to it.
// Deliberately NOT folded with the MCP catalog's unclassified-tool count
// (a live per-server tools/list probe the Pending panel fetches on its own, slower schedule,
// see routes/meta.ts's handleGetPermissionsPending) — that would put a slow network probe back
// on the nav's paint path, the exact thing splitting the route apart was meant to avoid.
export function pendingHasWarning(state) {
  return (state.pendingDenials ?? []).length > 0 || Boolean(state.pendingErr);
}
