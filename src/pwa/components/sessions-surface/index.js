// Sessions surface (list-detail-context layout). Wired into shell/surfaces.js's
// registry. Named "sessions-surface" (not "sessions") to avoid colliding with
// state/sessions.js.

import { nav, peekSessionHint } from '../../state/nav.js';
import { sessions } from '../../state/sessions.js';
import { installAppBridge } from '../../app-bridge.js';
import { workApi } from '../../net/work.js';
import { renderList as renderSessionsListColumn } from './list.js';
import { renderContext as renderSessionsRail } from './rail.js';
import { emptyState } from '../shell/placeholder.js';

// "Promote to tracked" (D4 #5 / ⌘⇧P): the backend endpoint and the bridge key
// both already exist (src/routes/jobs.ts, app-bridge.js) — this surface just
// fills the key, since it's the one place that needs it (session header CTA).
installAppBridge({
  async promoteSessionToJob(sessionId) {
    if (!sessionId) return;
    try {
      const { job } = await workApi.promoteFromSession(sessionId);
      if (job?.id) nav.select('tracked', job.id);
    } catch (e) {
      window.alert(`Promote to tracked failed: ${e.message}`);
    }
  },
});

// Brand-new / not-yet-in-`sessions.projects` sessions travel their spawn context via
// the nav session-hint side channel (list-sessions.js sets it on New-session/row click);
// otherwise derive it from the loaded project list.
function resolveSessionContext(id) {
  const hint = peekSessionHint(id);
  if (hint) return hint;
  for (const p of sessions.get().projects ?? []) {
    const match = (p.sessions ?? []).find((s) => s.id === id);
    if (match) {
      return {
        cwd: p.cwd,
        spawnCwd: match.worktreePath ?? p.cwd,
        title: match.title,
        worktreePath: match.worktreePath,
        worktreeBranch: match.worktreeBranch,
      };
    }
  }
  return {};
}

export function renderList(mount) {
  return renderSessionsListColumn(mount);
}

// Guards against remounting when the selected session hasn't changed (unmount
// hygiene mirrors shell/workspace.js's __svHandle pattern so WS refcounts don't leak).
export async function renderDetail(mount, deps) {
  const { selection } = deps ?? {};
  if (!selection) {
    if (mount.__svHandle) { try { mount.__svHandle.unmount(); } catch { /* ignore */ } mount.__svHandle = null; mount.__svSessionId = null; }
    emptyState(mount, 'Select a session, or start a new one from the list.');
    return;
  }
  if (mount.__svHandle && mount.__svSessionId === selection) return; // unchanged — don't remount
  if (mount.__svHandle) { try { mount.__svHandle.unmount(); } catch { /* ignore */ } mount.__svHandle = null; }
  mount.textContent = '';
  const ctx = resolveSessionContext(selection);
  const { mountSessionView } = await import('../session-view/index.js');
  // Selection may have moved on again while the dynamic import was in flight.
  if (nav.get().selectionBySurface.sessions !== selection) return;
  const handle = mountSessionView(mount, selection, ctx);
  mount.__svHandle = handle;
  mount.__svSessionId = selection;
}

export function renderContext(mount) {
  return renderSessionsRail(mount);
}
