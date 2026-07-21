// Layout-neutral session identity + action helpers shared by the desktop
// session-view header (index.js) and the mobile session header
// (mobile-header.js). Extracted so both chromes drive the same archive /
// delete / git-info logic instead of forking it per layout.

import { sessions } from '../../state/sessions.js';
import { refreshSessions } from '../../app-bridge.js';
import { fmtElapsedDuration } from '../../vm/sessions.js';

// Whether this session's project is diffable and, if so, what branch to label
// it with. Falls back to matching the project by the slice's cwd for freshly-
// spawned sessions the projects list hasn't caught up to yet (loadSessions
// hasn't refreshed since spawn), so the affordance appears immediately instead
// of only after a close/reopen cycle.
export function computeGitInfo(sessionId) {
  const s = sessions.get();
  let diffable = false;
  let branch = null;
  let matched = false;
  let archived = false;
  for (const p of s.projects ?? []) {
    const match = p.sessions?.find((x) => x.id === sessionId);
    if (match) {
      diffable = Boolean(p.isGitRepo) && !match.archived;
      branch = match.worktreeBranch ?? null;
      archived = Boolean(match.archived);
      matched = true;
      break;
    }
  }
  if (!matched) {
    const slice = sessions.getSlice(sessionId);
    const cwd = slice?.cwd ?? slice?.spawnCwd ?? null;
    if (cwd) {
      const p = (s.projects ?? []).find((pr) => pr.cwd === cwd);
      if (p) diffable = Boolean(p.isGitRepo);
    }
  }
  return { diffable, branch, matched, archived, isWorktree: matched && Boolean(branch) && !archived };
}

// Best-effort session name: prefer the live project-list title (kept fresh by
// loadSessions), fall back to the spawn-time meta the caller mounted us with
// (covers the gap before a brand-new session's first loadSessions refresh),
// then the session id. There's no rename endpoint/mechanism anywhere in the
// backend today (checked routes/sessions.ts) and the authoritative mockups
// (session-rail.html/sessions-list.html) render `.name` as plain text with no
// edit affordance — so this is display-only, not an oversight.
export function resolveSessionTitle(sessionId, meta) {
  for (const p of sessions.get().projects ?? []) {
    const match = p.sessions?.find((x) => x.id === sessionId);
    if (match?.title) return match.title;
  }
  return meta?.title || sessionId.slice(0, 8);
}

// Wall-clock "since we first noticed this session running" per sessionId —
// same approximation sessions-surface/list.js's runningSince tracker uses for
// its card duration badge (there's no true session-start timestamp on the
// slice). Module-scoped so it survives unmount/remount.
const runningSinceById = new Map();

export function sessionRunMeta(slice, sessionId) {
  const running = slice?.runState === 'foreground' || slice?.runState === 'background';
  if (running) {
    if (!runningSinceById.has(sessionId)) runningSinceById.set(sessionId, Date.now());
    const ms = Date.now() - runningSinceById.get(sessionId);
    return { live: true, text: `Running · ${fmtElapsedDuration(ms) || '0s'}` };
  }
  runningSinceById.delete(sessionId);
  return { live: false, text: 'Idle' };
}

// Desktop path passes no confirm and gets window.confirm; mobile passes
// sheet-utils' confirmInSheet, which takes the same options object.
const defaultConfirm = async ({ body }) => window.confirm(body);

// Returns true when the session was archived (false on cancel/failure) so
// callers can navigate away only on success.
export async function archiveSession(sessionId, confirm = defaultConfirm) {
  const { isWorktree } = computeGitInfo(sessionId);
  if (isWorktree) {
    const ok = await confirm({
      title: 'Archive this worktree?',
      body: 'Archive this worktree? The worktree directory and its branch will be deleted. The session transcript stays.',
      confirmLabel: 'Archive',
      danger: true,
    });
    if (!ok) return false;
  }
  // Flag the slice first so the daemon_proc_exit that archiving's SIGTERM
  // triggers renders as a calm "Session archived" notice instead of a crash
  // tile with a Reopen button.
  sessions.for(sessionId).expectArchive();
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, { method: 'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    sessions.for(sessionId).clearExpectArchive();
    window.alert(`Archive failed: ${e.message}`);
    return false;
  }
  refreshSessions();
  return true;
}

// Returns true when the session was deleted so callers can leave the (now
// gone) session view on their own layout's terms.
export async function deleteSession(sessionId, confirm = defaultConfirm) {
  const ok = await confirm({
    title: 'Delete this session?',
    body: 'Delete this session? The transcript is removed from disk. This cannot be undone.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return false;
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    if (!r.ok && r.status !== 204) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    window.alert(`Delete failed: ${e.message}`);
    return false;
  }
  refreshSessions();
  return true;
}
