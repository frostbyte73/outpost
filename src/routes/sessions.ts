import type { Server } from '../server.js';
import type { SessionStore } from '../session/session-store.js';
import type { SessionManager } from '../session/session-manager.js';
import type { WorktreeManager } from '../git/worktree-manager.js';
import type { ApprovalQueue } from '../permissions/approvals.js';
import type { Allowlist } from '../permissions/allowlist.js';
import type { RecurrenceTracker } from '../storage/recurrence-tracker.js';
import { readProjectContextWindow } from '../claude-config.js';

export interface SessionsRoutesDeps {
  sessionStore: SessionStore;
  manager: SessionManager;
  worktreeManager: WorktreeManager;
  queue: ApprovalQueue;
  recurrence: RecurrenceTracker;
  allowlist: Allowlist;
  latestStatuslineBySession: Map<string, object>;
  cwdForSession(sessionId: string): string | undefined;
  summarizeToolInput(toolName: string, toolInput: unknown): string;
  // Shared with daemon.ts's onSessionExit — both are call sites for the same
  // session-end event; runsCapture.onSessionEnd dedupes across them.
  captureSessionEnd(sessionId: string): void;
  info: {
    version: string;
    approvalTimeoutMs: number;
    home: string;
    slashCommands: unknown;
    vapidPublicKey: string;
  };
}

export function registerSessionsRoutes(server: Server, deps: SessionsRoutesDeps): void {
  const {
    sessionStore, manager, worktreeManager, queue, recurrence, allowlist,
    latestStatuslineBySession, cwdForSession, summarizeToolInput, captureSessionEnd, info,
  } = deps;

  server.route('GET', '/api/info', (_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      version: info.version,
      allowlistRuleCount: allowlist.ruleCount(),
      approvalTimeoutMs: info.approvalTimeoutMs,
      home: info.home,
      slashCommands: info.slashCommands,
      vapidPublicKey: info.vapidPublicKey,
    }));
  });

  server.route('GET', '/api/sessions', (_req, res) => {
    const projects = sessionStore.listProjects();
    // Project contextWindowSize is 1M iff the user ever ran the [1m] Opus variant there.
    for (const p of projects) {
      const cw = readProjectContextWindow(p.cwd);
      if (cw) p.contextWindowSize = cw;
    }
    // Annotate sessions with their kind (so the PWA can filter action-edit /
    // skill-edit sessions out of the Projects view) and live runState.
    for (const p of projects) {
      for (let i = 0; i < p.sessions.length; i++) {
        const id = p.sessions[i]!.id;
        const k = manager.getKind(id);
        p.sessions[i] = { ...p.sessions[i]!, ...(k ? { kind: k } : {}), runState: manager.runState(id) };
      }
    }
    const titleById = new Map<string, string>();
    for (const p of projects) for (const s of p.sessions) titleById.set(s.id, s.title);
    const pending = queue.listPending().map((a) => {
      const cwd = cwdForSession(a.sessionId);
      const suggestion = cwd ? recurrence.suggestionFor(cwd, a.toolName, a.toolInput) : null;
      return {
        approvalId: a.id,
        sessionId: a.sessionId,
        toolName: a.toolName,
        toolInput: a.toolInput,
        toolUseId: a.toolUseId,
        agentId: a.agentId,
        agentType: a.agentType,
        summary: summarizeToolInput(a.toolName, a.toolInput),
        sessionTitle: titleById.get(a.sessionId),
        enqueuedAt: a.enqueuedAt,
        suggestion,
      };
    });
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ projects, pending }));
  });

  server.route('GET', '/api/sessions/:id/messages', (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/sessions\/([\w-]+)\/messages$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const messages = sessionStore.readMessages(m[1]!);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ messages }));
  });

  server.route('GET', '/api/sessions/:id/subagents', (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/sessions\/([\w-]+)\/subagents$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const id = m[1]!;
    const subagents = sessionStore.readSubagents(id);
    // No live parent → any uncompleted agent died with the previous incarnation.
    if (!manager.isActive(id)) {
      const now = Date.now();
      for (const s of subagents) {
        if (!s.completion) s.completion = { status: 'killed', completedAt: now };
      }
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ subagents }));
  });

  server.route('DELETE', '/api/sessions/:id', async (req, res) => {
    const id = (req.url ?? '').split('/').pop()!;
    captureSessionEnd(id);
    await manager.close(id);
    const removed = sessionStore.delete(id);
    await worktreeManager.remove(id);
    latestStatuslineBySession.delete(id);
    console.log(`[api] delete session ${id.slice(0,8)} subprocess=killed file=${removed ? 'removed' : 'not-found'}`);
    res.statusCode = 204;
    res.end();
  });

  // Worktree sessions: tears down worktree + branch (destructive). Non-worktree: tombstone only.
  // JSONL is always retained so the transcript survives when archived rows are revealed.
  server.route('POST', '/api/sessions/:id/archive', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/sessions\/([\w-]+)\/archive$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const id = m[1]!;
    captureSessionEnd(id);
    await manager.close(id);
    const found = sessionStore.findSession(id);
    await worktreeManager.archive(id, found?.cwd);
    latestStatuslineBySession.delete(id);
    console.log(`[api] archive session ${id.slice(0,8)} (worktree removed, JSONL kept)`);
    res.statusCode = 204;
    res.end();
  });
}
