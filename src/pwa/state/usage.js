import { createStore } from './create-store.js';

const store = createStore({
  daemonInfo: null,
  slashCommands: [],
  statusline: null,
  statuslineBySession: new Map(),
  lastUsage: null,
  lastUsageBySession: new Map(),
  accountUsage: null,
  contextWindow: 200_000,
  projectContextWindow: null,
  meterBreakdownOpen: false,
});

export const usage = {
  get: store.get,
  set: store.set,
  subscribe: store.subscribe,

  setDaemonInfo(info) {
    store.set((s) => ({ ...s, daemonInfo: info }));
  },
  setSlashCommands(cmds) {
    store.set((s) => ({ ...s, slashCommands: cmds }));
  },
  setStatusline(line) {
    store.set((s) => ({ ...s, statusline: line }));
  },
  setStatuslineFor(sessionId, line) {
    store.set((s) => {
      const next = new Map(s.statuslineBySession);
      next.set(sessionId, line);
      return { ...s, statuslineBySession: next };
    });
  },
  setLastUsage(u) {
    store.set((s) => ({ ...s, lastUsage: u }));
  },
  setLastUsageFor(sessionId, u) {
    store.set((s) => {
      const next = new Map(s.lastUsageBySession);
      next.set(sessionId, u);
      return { ...s, lastUsageBySession: next };
    });
  },
  setAccountUsage(u) {
    store.set((s) => ({ ...s, accountUsage: u }));
  },
  setContextWindow(n) {
    store.set((s) => (s.contextWindow === n ? s : { ...s, contextWindow: n }));
  },
  setProjectContextWindow(n) {
    store.set((s) => (s.projectContextWindow === n ? s : { ...s, projectContextWindow: n }));
  },
  setMeterBreakdownOpen(v) {
    store.set((s) => ({ ...s, meterBreakdownOpen: !!v }));
  },
};
