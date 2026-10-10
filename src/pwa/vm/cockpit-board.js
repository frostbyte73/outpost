// Cockpit board view-model: every open job, every un-archived manual session, and the non-job
// attention items, as fixed-grammar rows ordered by when dc last touched them. Zero DOM.

import { isTerminalStep, draftAwaitsUser, planIsLive } from './work-predicates.js';
import { implementAwaitingPush, orchestratedRows, phaseLabelOf } from './tracked.js';
import { cockpitInbox } from './cockpit.js';
import { shortName } from '../utils/formatting.js';

export const OPENABLE = new Set(['plan-review', 'gate', 'draft', 'failed', 'wait', 'stall', 'driven', 'your-turn']);

const OTHER_KINDS = new Set(['routine-failed', 'action-proposal', 'schedule-proposal']);
const OTHER_KIND_LABEL = { 'routine-failed': 'routine', 'action-proposal': 'skill', 'schedule-proposal': 'schedule' };
// Mirrors AUTH_STOP_ERRORS (src/work/job-liveness.ts): the stalls a sign-in resumes on its own.
const AUTH_STOP_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed']);
const STOP_LABEL = { rate_limit: 'rate limit', overloaded: 'API overloaded', billing_error: 'billing error' };
const NO_LIVE = { orchestrator: false, stepIds: [], sessionIds: [], interactiveSessionIds: [] };

function isBacklog(j) {
  return j.state === 'planning' && !j.orchestratorSessionId && (j.steps ?? []).length === 0;
}

function stepAction(s) {
  return s.type === 'action' ? s.action : (s.boundAction ?? s.controller);
}

function failureReason(f) {
  return typeof f === 'string' ? f : (f?.reason ?? 'failed');
}

function jobSessionIds(j) {
  const ids = [j.orchestratorSessionId];
  for (const s of j.steps ?? []) {
    ids.push(s.sessionId);
    for (const d of s.dispatches ?? []) ids.push(d.sessionId);
  }
  return ids.filter(Boolean);
}

function jobFeeds(j) {
  const live = new Set((j.live ?? NO_LIVE).sessionIds ?? []);
  const feeds = [];
  if (j.orchestratorSessionId && live.has(j.orchestratorSessionId)) {
    feeds.push({ sessionId: j.orchestratorSessionId, stepId: null, repo: null, action: 'meta.orchestrate' });
  }
  for (const s of j.steps ?? []) {
    if (s.cancelled) continue;
    const repo = s.workspace?.repoCwd ? shortName(s.workspace.repoCwd) : null;
    if (s.sessionId && live.has(s.sessionId)) feeds.push({ sessionId: s.sessionId, stepId: s.id, repo, action: stepAction(s) });
    for (const d of s.dispatches ?? []) {
      if (d.status === 'running' && d.sessionId && live.has(d.sessionId)) {
        feeds.push({ sessionId: d.sessionId, stepId: s.id, repo, action: d.action });
      }
    }
  }
  return feeds;
}

function jobActions(j, pendingApprovals) {
  const out = [];
  const live = j.live ?? NO_LIVE;
  const driven = new Set(live.interactiveSessionIds ?? []);
  const liveSteps = new Set(live.stepIds ?? []);
  if (j.state === 'plan_pending_review') out.push({ kind: 'plan-review' });
  const stall = (j.stalls ?? [])[0];
  if (stall) out.push({ kind: 'stall', auth: AUTH_STOP_ERRORS.has(stall.error), error: stall.error });
  for (const s of j.steps ?? []) {
    if (s.cancelled) continue;
    if (s.failure && !liveSteps.has(s.id)) out.push({ kind: 'failed', stepId: s.id, reason: failureReason(s.failure) });
    if (isTerminalStep(s)) continue;
    if (s.sessionId && driven.has(s.sessionId)) { out.push({ kind: 'driven', stepId: s.id, sessionId: s.sessionId }); continue; }
    if (s.type === 'orchestrated' && s.gate) out.push({ kind: 'gate', stepId: s.id, phase: s.phase ?? null, question: s.gate.question ?? '' });
    for (const d of s.drafts ?? []) if (draftAwaitsUser(s, d)) out.push({ kind: 'draft', stepId: s.id, draftId: d.id });
    if (s.type === 'action' && s.state === 'waiting' && s.resumeAt == null) {
      out.push({ kind: 'wait', stepId: s.id, reason: s.inputs?.reason ? String(s.inputs.reason) : '' });
    }
  }
  const push = implementAwaitingPush(j);
  if (push) out.push({ kind: 'push', stepId: push.id, sessionId: push.sessionId });
  if (j.state === 'failed' && !out.some((a) => a.kind === 'failed')) {
    out.push({ kind: 'failed', stepId: null, reason: j.failure?.reason ?? 'Job failed' });
  }
  const mine = new Set(jobSessionIds(j));
  for (const a of pendingApprovals) {
    if (mine.has(a.sessionId) && !a.agentId) {
      out.push({ kind: 'approval', sessionId: a.sessionId, approvalId: a.approvalId, toolName: a.toolName ?? 'tool' });
    }
  }
  return out;
}

const ACTION_TEXT = {
  'plan-review': (a, j) => `Plan review · ${(j.steps ?? []).length} steps`,
  gate: (a) => (a.phase === 'spec' ? 'Spec ready' : a.phase === 'plan' ? 'Plan ready' : (a.question || 'Approve move')),
  draft: () => '1 write to approve',
  failed: (a) => `Failed: ${a.reason}`,
  wait: (a) => (a.reason ? `On hold: ${a.reason}` : 'On hold'),
  stall: (a) => (a.auth ? 'Sign in needed' : `Stopped: ${STOP_LABEL[a.error] ?? 'API error'}`),
  push: () => 'Review diff & push',
  approval: (a) => `Approve ${a.toolName}`,
  driven: () => 'You have the wheel',
  'your-turn': () => 'Your turn',
};

const ACTION_BUTTON = {
  'plan-review': () => 'Review plan',
  gate: (a) => (a.phase === 'spec' ? 'Review spec' : a.phase === 'plan' ? 'Review plan' : 'Review'),
  draft: () => 'Review write',
  failed: () => 'Review',
  wait: () => 'Review',
  stall: (a) => (a.auth ? 'Sign in' : 'Resume'),
  push: () => 'Review diff',
  approval: () => 'Review',
  driven: () => 'Open',
  'your-turn': () => 'Reply',
};

function actionsText(actions, j) {
  if (actions.length === 1) return ACTION_TEXT[actions[0].kind](actions[0], j);
  if (actions.every((a) => a.kind === 'draft')) return `${actions.length} writes to approve`;
  return `${actions.length} need you`;
}

function actionLabel(actions) {
  if (!actions.length) return null;
  return actions.length === 1 ? ACTION_BUTTON[actions[0].kind](actions[0]) : 'Review';
}

function prNumber(url) {
  return /\/pull\/(\d+)/.exec(url ?? '')?.[1] ?? null;
}

function idleText(j, feeds) {
  if (feeds.length) {
    const step = (j.steps ?? []).find((s) => !s.cancelled && feeds.some((f) => f.stepId === s.id));
    if (!step) return 'Planning';
    return (step.type === 'orchestrated' && phaseLabelOf(step)) || step.title;
  }
  if (!planIsLive(j)) return j.orchestratorSessionId ? 'Planning' : 'Not launched';
  const step = (j.steps ?? []).find((s) => !s.cancelled && !isTerminalStep(s));
  if (!step) return 'Waiting';
  if (step.type !== 'orchestrated') return step.state === 'waiting' ? 'Soaking' : 'Queued';
  const line = orchestratedRows(step).statusLine ?? 'Waiting';
  const pr = prNumber(step.pr?.prUrl);
  return pr ? `PR #${pr} · ${line}` : line;
}

function jobRow(j, pendingApprovals) {
  const actions = jobActions(j, pendingApprovals);
  const feeds = jobFeeds(j);
  const onlyFailed = actions.length > 0 && actions.every((a) => a.kind === 'failed');
  let tone;
  if (j.state === 'failed') tone = 'failed';
  else if (feeds.length) tone = 'live';
  else if (onlyFailed) tone = 'failed';
  else if (actions.length) tone = 'you';
  else tone = planIsLive(j) ? 'parked' : 'idle';
  const status = actions.length
    ? { text: actionsText(actions, j), tone: onlyFailed ? 'failed' : 'you' }
    : { text: idleText(j, feeds), tone: feeds.length ? 'live' : 'mute' };
  return {
    key: `job:${j.id}`, kind: 'job', id: j.id,
    ref: j.externalRef?.issueIdentifier ?? null, refMono: true, kindLabel: null,
    title: j.title ?? '(untitled job)', tone, status, time: j.updatedAt ?? 0,
    actions, actionLabel: actionLabel(actions), feeds,
    engagedAt: j.lastEngagedAt ?? j.createdAt ?? 0, createdAt: j.createdAt ?? 0, cwd: null, inboxItem: null,
  };
}

const ALIVE = new Set(['foreground', 'background']);

function sessionRow(s, cwd, slice, pendingApprovals, localEngaged) {
  const alive = ALIVE.has(slice?.runState ?? s.runState);
  const working = !!slice?.thinking;
  const pending = pendingApprovals.filter((a) => a.sessionId === s.id && !a.agentId);
  const actions = pending.length
    ? pending.map((a) => ({ kind: 'approval', sessionId: s.id, approvalId: a.approvalId, toolName: a.toolName ?? 'tool' }))
    : (alive && !working ? [{ kind: 'your-turn', sessionId: s.id }] : []);
  const tone = working ? 'live' : actions.length ? 'you' : 'idle';
  let status;
  if (working) status = { text: 'Working', tone: 'live' };
  else if (actions.length) status = { text: actionsText(actions, null), tone: 'you' };
  else status = { text: 'Idle', tone: 'mute' };
  return {
    key: `session:${s.id}`, kind: 'session', id: s.id,
    ref: shortName(cwd), refMono: true, kindLabel: null,
    title: s.title ?? 'Untitled session', tone, status, time: s.lastModified ?? 0,
    actions, actionLabel: actionLabel(actions),
    feeds: alive ? [{ sessionId: s.id, stepId: null, repo: null, action: null }] : [],
    engagedAt: Math.max(s.lastEngagedAt ?? s.lastModified ?? 0, localEngaged.get(s.id) ?? 0),
    createdAt: s.lastModified ?? 0, cwd, inboxItem: null,
  };
}

function otherRow(item) {
  const isSkill = item.kind === 'action-proposal';
  const failed = item.tone === 'warn';
  return {
    key: `other:${item.key}`, kind: 'other', id: item.key,
    ref: isSkill ? item.title : null, refMono: isSkill, kindLabel: OTHER_KIND_LABEL[item.kind],
    title: isSkill ? (item.detail ?? '') : (item.title ?? ''),
    tone: failed ? 'failed' : 'you',
    status: failed ? { text: item.detail ?? 'Failed', tone: 'failed' } : { text: 'Review', tone: 'you' },
    time: item.time ?? 0, actions: [], actionLabel: null, feeds: [],
    engagedAt: item.time ?? 0, createdAt: item.time ?? 0, cwd: null, inboxItem: item,
  };
}

const byEngaged = (a, b) => b.engagedAt - a.engagedAt;
const byCreated = (a, b) => b.createdAt - a.createdAt;
const byTime = (a, b) => b.time - a.time;

export function cockpitBoard({
  jobs = [], projects = [], slices = new Map(), pendingApprovals = [], localEngaged = new Map(),
  actionEdits = [], scheduleDrafts = new Map(), runs = [], autoApplied = [], now = Date.now(),
} = {}) {
  const started = [], notStarted = [], backlog = [];
  for (const j of jobs) {
    if (j.state === 'done' || j.state === 'abandoned') continue;
    const row = jobRow(j, pendingApprovals);
    if (planIsLive(j)) started.push(row);
    else if (isBacklog(j)) backlog.push(row);
    else notStarted.push(row);
  }
  const sessions = [];
  for (const p of projects) {
    for (const s of p.sessions ?? []) {
      if (s.archived || s.sessionClass === 'action' || (s.kind && s.kind !== 'normal')) continue;
      sessions.push(sessionRow(s, p.cwd, slices.get(s.id), pendingApprovals, localEngaged));
    }
  }
  const inbox = cockpitInbox({ actionEdits, scheduleDrafts, runs, autoApplied, now });
  const other = [...inbox.decide, ...inbox.broken].filter((i) => OTHER_KINDS.has(i.kind)).map(otherRow);

  started.sort(byEngaged);
  notStarted.sort(byEngaged);
  backlog.sort(byCreated);
  sessions.sort(byEngaged);
  other.sort(byTime);

  const all = [...started, ...notStarted, ...backlog, ...sessions, ...other];
  return {
    tally: {
      working: all.filter((r) => r.tone === 'live').length,
      needYou: all.filter((r) => r.actions.length > 0 || (r.kind === 'other' && r.tone === 'you')).length,
      parked: all.filter((r) => r.tone === 'parked').length,
      failed: all.filter((r) => r.tone === 'failed').length,
    },
    started, notStarted, backlog, sessions, other,
    empty: all.length === 0,
  };
}

export function stabilizeOrder(prevKeys, keys, frozen) {
  if (!frozen || !prevKeys) return keys;
  const present = new Set(keys);
  const kept = prevKeys.filter((k) => present.has(k));
  const keptSet = new Set(kept);
  return [...kept, ...keys.filter((k) => !keptSet.has(k))];
}

export function sessionsShownInBody(row, mode) {
  if (!mode) return [];
  if (row.kind === 'session') return [row.id];
  if (row.kind === 'job' && mode === 'action') {
    return row.actions.filter((a) => a.kind === 'driven').map((a) => a.sessionId);
  }
  return [];
}
