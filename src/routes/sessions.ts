import type { Server } from '../server.js';
import type { SessionStore } from '../session/session-store.js';
import type { SessionManager } from '../session/session-manager.js';
import type { WorktreeManager } from '../git/worktree-manager.js';
import type { ApprovalQueue } from '../permissions/approvals.js';
import type { Allowlist } from '../permissions/allowlist.js';
import type { RecurrenceTracker } from '../storage/recurrence-tracker.js';
import type { InteractiveStore } from '../session/interactive-store.js';
import { readProjectContextWindow } from '../claude-config.js';
import { readJsonObject } from './util.js';

const TOOK_WHEEL = 'The user has taken the wheel on this session. Autopilot is paused: '
  + 'submit_step_output, submit_step_progress and submit_plan are refused until they hand '
  + 'control back, and nothing will resume you on a timer or an external event. Answer them, '
  + 'make the changes they ask for, and stop your turn to wait for their next message. If you '
  + 'need an external write, draft it with submit_write_draft as usual.';

const GAVE_WHEEL = 'The user has handed control back. Autopilot resumes. State in one line '
  + 'what changed as a result of the conversation, then carry on with your work and report '
  + 'your move as usual.';

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
  interactive: InteractiveStore;
  // Resolves a session to the job/step it drives, or undefined when the user may not take
  // the wheel on it. Wired to WorkEngine.interactiveTarget.
  interactiveTarget(sessionId: string): { jobId: string; stepId?: string } | undefined;
  // Does the daemon own this session at all? Distinguishes the route's 404 from its 409.
  jobIdForSession(sessionId: string): string | undefined;
  // Re-runs the job's decision pass, so whatever the pause held (a queued inbox, a due
  // timer) is picked up the moment control comes back.
  tickJob(jobId: string): void;
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
    interactive, interactiveTarget, jobIdForSession, tickJob,
  } = deps;

  function sendHandover(sessionId: string, tookWheel: boolean): void {
    // Fire-and-forget: SessionManager.send throws for a session whose subprocess has been
    // reaped, and a reaped session picks the flag up from its envelope on the next resume.
    try {
      manager.send(sessionId, {
        type: 'user',
        message: { role: 'user', content: tookWheel ? TOOK_WHEEL : GAVE_WHEEL },
      });
    } catch (e) {
      console.warn(`[api] handover to ${sessionId.slice(0, 8)} failed: ${(e as Error).message}`);
    }
  }

  server.route('POST', '/api/sessions/:id/interactive', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/sessions\/([\w-]+)\/interactive$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const sessionId = m[1]!;
    const payload = await readJsonObject<{ on?: unknown }>(req, res);
    if (!payload) return;
    if (typeof payload.on !== 'boolean') { res.statusCode = 400; res.end('on (boolean) required'); return; }
    const target = interactiveTarget(sessionId);
    if (!target) {
      // Two different answers: a session with no work role isn't ours to pause (a plain PWA
      // session is already interactive), which is a 404; a session whose step has settled is
      // ours but has no autopilot left to pause, which is a 409.
      const known = jobIdForSession(sessionId) !== undefined;
      res.statusCode = known ? 409 : 404;
      res.end(known ? 'step has already settled' : 'not a session the daemon drives');
      return;
    }
    if (payload.on) {
      // Set before the interrupt: the Stop this provokes must already see the flag, or the
      // engine arms an unresolved-step failure against a session the user just took over.
      interactive.set(sessionId, true);
      // A message typed into a session mid tool-loop lands whenever that loop happens to
      // finish, which is not "taking the wheel".
      try { manager.interrupt(sessionId); } catch { /* not mid-turn; nothing to stop */ }
      sendHandover(sessionId, true);
    } else {
      interactive.set(sessionId, false);
      sendHandover(sessionId, false);
      tickJob(target.jobId);
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ interactive: payload.on }));
  });

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
