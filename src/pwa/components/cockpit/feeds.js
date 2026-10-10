import { mountInlineSession } from '../work/inline-session.js';
import { actionCategory, actionDisplayName } from '../work/action-icon.js';
import { escapeHtml } from '../../util.js';

function whoHtml(f) {
  const repo = f.repo ? `<span class="ckb-feed-repo">${escapeHtml(f.repo)}</span>` : '';
  const act = f.action
    ? `<span class="type-mono" data-cat="${escapeHtml(actionCategory(f.action))}">${escapeHtml(actionDisplayName(f.action))}</span>`
    : '';
  return repo + act;
}

// Keyed by sessionId so a feed that stays live keeps its mount (and its WS) across repaints.
export function syncFeeds(container, feeds, { jobId = null } = {}) {
  const prev = container.__feeds ?? new Map();
  const next = new Map();
  for (const f of feeds) {
    let entry = prev.get(f.sessionId);
    if (!entry) {
      const el = document.createElement('div');
      el.className = 'ckb-feed';
      el.innerHTML = '<div class="ckb-feed-who"></div><div class="ckb-feed-mount"></div>';
      const handle = mountInlineSession(el.querySelector('.ckb-feed-mount'), f.sessionId, { jobId, live: true, bare: true });
      entry = { el, handle, who: null };
    }
    const who = whoHtml(f);
    if (entry.who !== who) { entry.el.querySelector('.ckb-feed-who').innerHTML = who; entry.who = who; }
    next.set(f.sessionId, entry);
  }
  for (const [id, entry] of prev) {
    if (!next.has(id)) { entry.handle.unmount(); entry.el.remove(); }
  }
  let cursor = container.firstChild;
  for (const entry of next.values()) {
    if (entry.el === cursor) cursor = cursor.nextSibling;
    else container.insertBefore(entry.el, cursor);
  }
  container.__feeds = next;
}

export function teardownFeeds(container) {
  for (const entry of (container.__feeds ?? new Map()).values()) entry.handle.unmount();
  container.__feeds = new Map();
  container.textContent = '';
}
