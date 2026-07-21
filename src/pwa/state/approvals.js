import { createStore } from './create-store.js';

const initial = {
  pending: [],
  rejectionDrafts: new Map(),
  rejectionReasons: new Map(),
  consumedTaskResults: new Set(),
  pendingAsks: new Map(),
  pendingDecides: [],
};

const store = createStore(initial);

// In-progress Ask card state keyed by approvalId. reply=free-text draft; picks maps
// question-index → selected option-indices (single-select is a 1-element array,
// multi-select is 0+ toggled indices). Persisted across transcript re-renders so
// typing and selections survive the innerHTML rebuild that fires on every WS event.
//
// Kept OFF the reactive store on purpose: routing keystroke-driven draft updates
// through store.set would notify subscribers (session-view's paint), rebuild the
// textarea DOM mid-keystroke, and lose focus/caret/scroll. The ask-card handlers
// already update option-button classes and armed state in place, so no subscriber
// needs to react to draft changes.
const askDrafts = new Map();

export const approvals = {
  get: store.get,
  set: store.set,
  subscribe: store.subscribe,

  setPending(list) {
    store.set((s) => ({ ...s, pending: list }));
  },
  addPending(a) {
    store.set((s) => {
      if (s.pending.some((x) => x.approvalId === a.approvalId)) return s;
      return { ...s, pending: [...s.pending, a] };
    });
  },
  removePending(id) {
    store.set((s) => ({ ...s, pending: s.pending.filter((x) => x.approvalId !== id) }));
  },
  setRejectionDraft(id, text) {
    store.set((s) => {
      const next = new Map(s.rejectionDrafts);
      next.set(id, text);
      return { ...s, rejectionDrafts: next };
    });
  },
  clearRejectionDraft(id) {
    store.set((s) => {
      const next = new Map(s.rejectionDrafts);
      next.delete(id);
      return { ...s, rejectionDrafts: next };
    });
  },
  recordRejection(toolUseId, reason) {
    store.set((s) => {
      const next = new Map(s.rejectionReasons);
      next.set(toolUseId, { reason });
      return { ...s, rejectionReasons: next };
    });
  },
  markTaskResultConsumed(toolUseId) {
    store.set((s) => {
      const next = new Set(s.consumedTaskResults);
      next.add(toolUseId);
      return { ...s, consumedTaskResults: next };
    });
  },
  registerPendingAsk(toolUseId, entry) {
    store.set((s) => {
      const next = new Map(s.pendingAsks);
      next.set(toolUseId, entry);
      return { ...s, pendingAsks: next };
    });
  },
  resolvePendingAsk(toolUseId) {
    store.set((s) => {
      const next = new Map(s.pendingAsks);
      const had = next.delete(toolUseId);
      return had ? { ...s, pendingAsks: next } : s;
    });
  },
  getAskDraft(id) {
    return askDrafts.get(id) || { reply: '', picks: {} };
  },
  setAskReplyDraft(id, text) {
    const cur = askDrafts.get(id) || { reply: '', picks: {} };
    askDrafts.set(id, { ...cur, reply: text });
  },
  toggleAskPick(id, qi, oi, multi) {
    const cur = askDrafts.get(id) || { reply: '', picks: {} };
    const picks = { ...cur.picks };
    const existing = picks[qi] || [];
    if (multi) {
      picks[qi] = existing.includes(oi) ? existing.filter((x) => x !== oi) : [...existing, oi];
    } else {
      picks[qi] = existing.length === 1 && existing[0] === oi ? [] : [oi];
    }
    askDrafts.set(id, { ...cur, picks });
  },
  clearAskDraft(id) {
    askDrafts.delete(id);
  },
  enqueueDecide(d) {
    store.set((s) => ({ ...s, pendingDecides: [...s.pendingDecides, d] }));
  },
  drainDecides() {
    const out = store.get().pendingDecides;
    store.set((s) => ({ ...s, pendingDecides: [] }));
    return out;
  },
};
