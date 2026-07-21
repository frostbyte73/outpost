// Cold-start deep-link handling. A URL like `?session=abc&approval=xyz` opens
// the session and highlights the approval card once it hydrates. `?job=`
// `?schedule=` `?run=` `?skill=` route into the nav surfaces (D8) — mobile's
// tab bar reads the same nav store (P3), so these now apply on both layouts.
// The initial link is captured on module import BEFORE the URL is stripped,
// so navigation (reload / back / forward) doesn't re-fire the highlight.

import { sessions } from './state/sessions.js';
import { openSession } from './app-bridge.js';

const SURFACE_PARAMS = {
  job: 'tracked',
  schedule: 'schedules',
  run: 'runs',
  skill: 'skills',
};

export function readDeepLinkFromUrl() {
  const params = new URLSearchParams(location.search);
  const sessionId = params.get('session');
  const approvalId = params.get('approval');
  for (const [param, surface] of Object.entries(SURFACE_PARAMS)) {
    const id = params.get(param);
    if (id) return { surface, id };
  }
  if (!sessionId) return null;
  return { sessionId, approvalId };
}

export function highlightApprovalCard(approvalId) {
  const el = document.querySelector(`.approval-card[data-approval-id="${CSS.escape(approvalId)}"]`);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('approval-card-highlight');
  setTimeout(() => el.classList.remove('approval-card-highlight'), 2000);
  return true;
}

async function applySurfaceDeepLink(target) {
  const { nav } = await import('./state/nav.js');
  nav.select(target.surface, target.id);
}

export function applyDeepLink(target) {
  if (!target) return;
  if (target.surface) {
    applySurfaceDeepLink(target);
    return;
  }
  if (!target.sessionId) return;
  const go = () => {
    if (sessions.get().currentSessionId !== target.sessionId) {
      openSession({ id: target.sessionId });
    }
    if (!target.approvalId) return;
    // Approval card may not be in the DOM until openSession finishes hydrating.
    // Retry briefly before giving up.
    let tries = 0;
    const tick = () => {
      if (highlightApprovalCard(target.approvalId)) return;
      if (++tries > 30) return;
      setTimeout(tick, 100);
    };
    tick();
  };
  if (sessions.get().projects.length === 0) setTimeout(go, 0);
  else go();
}

// Capture at module-import time and strip the URL so a reload doesn't re-fire.
export const initialDeepLink = readDeepLinkFromUrl();
if (initialDeepLink) {
  history.replaceState(null, '', location.pathname + location.hash);
}
