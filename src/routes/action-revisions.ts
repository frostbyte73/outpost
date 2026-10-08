import { lstatSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from '../server.js';
import { actionDirFor } from '../actions/registry.js';
import { regressionVerdict } from '../actions/revision-stats.js';
import { unifiedSkillDiff } from '../actions/skill-diff.js';
import type { ActionsStore } from '../storage/actions-store.js';
import type { ActionRunRecord } from '../storage/action-runs-store.js';
import {
  BODY_CHANGING,
  type ActionAuthor,
  type ActionEvent,
  type ActionEventKind,
  type ActionRevisionsStore,
} from '../storage/action-revisions-store.js';
import { readJsonBody } from './util.js';

// Read + revert surface over ActionRevisionsStore. Split out of routes/actions.ts (already
// ~700 lines) rather than added to it. Diffs are derived here, on read, so the store stays
// unaware of diffing and a pruned neighbour can't leave a stale one behind.

export interface ActionRevisionsRoutesDeps {
  outpostActionsDir: string;
  actionsStore: ActionsStore;
  revisionsStore: ActionRevisionsStore;
  notifyAll: (message: unknown) => void;
  // ensureActionsInstalled + registry.load, as routes/actions.ts runs after an apply — without
  // it the detail pane renders a stale or missing skill.
  reloadActions: () => void;
}

export interface RevisionView {
  id: string;
  kind: ActionEventKind;
  at: number;
  author: ActionAuthor;
  hasBody: boolean;
  canRevert: boolean;
  diff?: string;
  bodyBytes?: number;
  rationale?: string;
  feedback?: string;
  allowlistAdds?: ActionEvent['allowlistAdds'];
  allowlistRemoved?: ActionEvent['allowlistRemoved'];
  sessionId?: string;
  revertOf?: string;
}

export class RevertError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function ruleKey(kind: string, value: string): string {
  return `${kind} ${value}`;
}

function diffFor(store: ActionRevisionsStore, action: string, event: ActionEvent, body: string): string {
  if (event.kind === 'deleted') return unifiedSkillDiff(body, '');
  if (BODY_CHANGING.has(event.kind)) {
    return unifiedSkillDiff(store.previousBodyOf(action, event.id) ?? '', body);
  }
  // A proposal is only meaningful against whatever was installed when it was posted.
  return unifiedSkillDiff(store.headBodyAt(action, event.at) ?? '', body);
}

export function buildRevisionHistory(store: ActionRevisionsStore, action: string): RevisionView[] {
  return store.listByAction(action).map((e) => {
    const body = store.bodyFor(e.bodySha);
    const view: RevisionView = {
      id: e.id,
      kind: e.kind,
      at: e.at,
      author: e.author,
      hasBody: body !== undefined,
      canRevert: BODY_CHANGING.has(e.kind) && e.kind !== 'deleted' && body !== undefined,
    };
    if (body !== undefined) view.diff = diffFor(store, action, e, body);
    if (e.bodyBytes !== undefined) view.bodyBytes = e.bodyBytes;
    if (e.rationale) view.rationale = e.rationale;
    if (e.feedback) view.feedback = e.feedback;
    if (e.allowlistAdds?.length) view.allowlistAdds = e.allowlistAdds;
    if (e.allowlistRemoved?.length) view.allowlistRemoved = e.allowlistRemoved;
    if (e.sessionId) view.sessionId = e.sessionId;
    if (e.revertOf) view.revertOf = e.revertOf;
    return view;
  });
}

// Rules this revision added, minus any that another *applied* revision also added. Proposals
// are excluded from the guard: a proposal records what it suggested, which isn't evidence the
// rule ever landed, and the approved event records the same rule.
function revokeRules(
  store: ActionRevisionsStore,
  actionsStore: ActionsStore,
  action: string,
  target: ActionEvent,
): Array<{ kind: string; value: string }> {
  const adds = target.allowlistAdds ?? [];
  if (adds.length === 0) return [];
  const elsewhere = new Set<string>();
  for (const e of store.listByAction(action)) {
    if (e.id === target.id || !BODY_CHANGING.has(e.kind)) continue;
    for (const r of e.allowlistAdds ?? []) elsewhere.add(ruleKey(r.kind, r.value));
  }
  const removed: Array<{ kind: string; value: string }> = [];
  for (const r of adds) {
    if (elsewhere.has(ruleKey(r.kind, r.value))) continue;
    if (actionsStore.removeRule(action, r.kind, r.value)) removed.push({ kind: r.kind, value: r.value });
  }
  return removed;
}

export function revertToEvent(input: {
  store: ActionRevisionsStore;
  actionsStore: ActionsStore;
  action: string;
  dir: string;
  eventId: string;
  author: ActionAuthor;
  rationale?: string;
  // Whose rules to revoke, when that isn't the revision being restored.
  revokeOf?: string;
}): { event: ActionEvent; removed: Array<{ kind: string; value: string }> } {
  const { store, actionsStore, action, dir, eventId, author, rationale, revokeOf } = input;
  const target = store.eventById(action, eventId);
  if (!target) throw new RevertError(404, 'no such revision');
  if (!BODY_CHANGING.has(target.kind) || target.kind === 'deleted') {
    throw new RevertError(400, `a ${target.kind} revision has no applied body to restore`);
  }
  const body = store.bodyFor(target.bodySha);
  if (body === undefined) throw new RevertError(409, 'this revision is too old — its body is no longer retained');

  const revokeTarget = revokeOf ? store.eventById(action, revokeOf) : target;
  const removed = revokeTarget ? revokeRules(store, actionsStore, action, revokeTarget) : [];
  const event = store.applyWrite({
    action, dir, body, author, kind: 'reverted', revertOf: target.id, allowlistRemoved: removed,
    ...(rationale ? { rationale } : {}),
  });
  return { event, removed };
}

export interface AutoRevertDeps {
  store: ActionRevisionsStore;
  actionsStore: ActionsStore;
  runsFor: (action: string) => ActionRunRecord[];
  dirFor: (action: string) => string;
  onReverted: (action: string) => void;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

// Undoes an improver revision whose verbatim rate fell against the one it replaced.
export function autoRevertIfRegressed(action: string, deps: AutoRevertDeps): ActionEvent | undefined {
  const verdict = regressionVerdict(deps.store.listByAction(action), deps.runsFor(action));
  if (!verdict.regressed) return undefined;
  const { event } = revertToEvent({
    store: deps.store, actionsStore: deps.actionsStore, action, dir: deps.dirFor(action),
    eventId: verdict.restoreEventId, revokeOf: verdict.regressedEventId, author: 'system',
    rationale: `regression: ${pct(verdict.before)} → ${pct(verdict.after)} verbatim`,
  });
  console.log(`[improver] auto-reverted ${action}: ${event.rationale}`);
  deps.onReverted(action);
  return event;
}

export function registerActionRevisionsRoutes(server: Server, deps: ActionRevisionsRoutesDeps): void {
  const { outpostActionsDir, actionsStore, revisionsStore, notifyAll, reloadActions } = deps;

  function resolve(res: ServerResponse, name: string): string | null {
    try { return actionDirFor(outpostActionsDir, name).dir; }
    catch (e) { res.statusCode = 400; res.end(`invalid action name: ${(e as Error).message}`); return null; }
  }

  // An action with no recorded history answers 200 with an empty list, not 404 — same reason
  // the scorecard route answers a zeroed card.
  function handleList(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '').split('?')[0]!;
    const m = path.match(/^\/api\/actions\/([^/]+)\/revisions$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const name = decodeURIComponent(m[1]!);
    if (!resolve(res, name)) return;
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ events: buildRevisionHistory(revisionsStore, name) }));
  }

  async function handleRevert(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0]!;
    const m = path.match(/^\/api\/actions\/([^/]+)\/revisions\/([^/]+)\/revert$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const name = decodeURIComponent(m[1]!);
    const eventId = decodeURIComponent(m[2]!);
    const dir = resolve(res, name);
    if (!dir) return;
    try { if (!lstatSync(dir).isDirectory()) throw new Error('not a dir'); }
    catch { res.statusCode = 404; res.end('no such action'); return; }

    const payload = await readJsonBody<{ actor?: string }>(req);
    const author: ActionAuthor = payload?.actor === 'improver' ? 'improver' : 'user';
    let result: ReturnType<typeof revertToEvent>;
    try {
      result = revertToEvent({ store: revisionsStore, actionsStore, action: name, dir, eventId, author });
    } catch (e) {
      const status = e instanceof RevertError ? e.status : 500;
      res.statusCode = status;
      res.end((e as Error).message);
      return;
    }
    reloadActions();
    try { notifyAll({ type: 'actions_changed' }); } catch { /* tolerate */ }
    try { notifyAll({ type: 'action_revised', action: name }); } catch { /* tolerate */ }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, eventId: result.event.id, removed: result.removed }));
  }

  server.route('GET', '/api/actions/:name/revisions', async (req, res) => handleList(req, res));
  server.route('POST', '/api/actions/:name/revisions/:eventId/revert', handleRevert);
}
