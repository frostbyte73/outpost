// Decode + dispatch for inbound frames on the two PWA-facing WebSocket connections
// (`/ws/notifications`, `/ws/sessions/:id`), wired up by daemon.ts's `server.onWebSocket`
// handler. Pulled out of daemon.ts because `ws.on('message', ...)` runs with no
// surrounding try/catch anywhere in the stack — a throw inside the listener propagates
// out of the EventEmitter and kills the process, so the decode step has to be provably
// safe, and that's easiest to pin down in an isolated, unit-testable function.
import { parseJsonObject } from '../routes/util.js';
import type { ApprovalMode } from '../permissions/approval-mode.js';
import { buildTurnInput, makeUploadSaver, parseAttachments } from '../session/attachments.js';
import type { TurnInput } from '../runtime/types.js';

type RawFrame = Buffer | ArrayBuffer | Buffer[];

// ws's `RawData` union also allows `Buffer[]` (a binary frame's fragments, only handed
// back unmerged when the socket's `binaryType` is set to `'fragments'`) and `ArrayBuffer`
// (only when `binaryType` is `'arraybuffer'`). Neither is reachable today — this server
// never touches `.binaryType` on any WebSocket, and the PWA client always sends JSON as a
// text frame, which `ws` merges into one Buffer before emitting 'message' regardless of
// binaryType. Handled anyway: `String(rawArray)` would join fragments with a literal
// comma and decode each one to UTF-8 independently, mangling any multi-byte character
// split across a fragment boundary.
function frameToString(raw: RawFrame): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return raw.toString('utf8');
}

// `JSON.parse('null')` doesn't throw — it returns `null`, and dereferencing `.type` on
// that throws a TypeError with nothing downstream to catch it (a bare `try/catch` around
// the `JSON.parse` call only guards the parse itself). `'42'`/`'"str"'`/`'true'`/`'[]'`
// don't crash the same way — primitives and arrays tolerate `.type` access via
// autoboxing — but reusing the same plain-object guard the HTTP surfaces use
// (routes/util.ts's `parseJsonObject`) makes every non-object frame body a defined
// no-op rather than an accident of which JS values happen to support property access.
export function parseWsFrame(raw: RawFrame): Record<string, unknown> | null {
  return parseJsonObject(frameToString(raw));
}

interface ApprovalDecideTarget {
  decide(approvalId: string, decision: { allow: boolean; reason?: string }): void;
}

export interface NotificationsMessageDeps {
  queue: ApprovalDecideTarget;
}

// `/ws/notifications` accepts `approval_decide` too: that connection survives iOS
// backgrounding when the session WS often doesn't.
export function handleNotificationsMessage(raw: RawFrame, deps: NotificationsMessageDeps): void {
  const msg = parseWsFrame(raw);
  if (!msg) return;
  if (msg.type === 'approval_decide') {
    const { approvalId, decision, reason } = msg as { approvalId: string; decision: 'allow' | 'deny'; reason?: string };
    deps.queue.decide(approvalId, { allow: decision === 'allow', reason });
  }
}

interface SessionMessageTarget {
  sendTurn(sessionId: string, turn: TurnInput): void;
  interrupt(sessionId: string): void;
  broadcast(sessionId: string, message: unknown): void;
  isLive(sessionId: string): boolean;
  wake(sessionId: string): Promise<void>;
}

interface ApprovalModeTarget {
  set(sessionId: string, mode: ApprovalMode): void; // throws on an unrecognized mode
}

interface ShellTarget {
  run(sessionId: string, execId: string, command: string): Promise<void>;
  drain(sessionId: string): string;
  restore(sessionId: string, blocks: string): void;
}

export interface SessionMessageDeps {
  queue: ApprovalDecideTarget;
  manager: SessionMessageTarget;
  modes: ApprovalModeTarget;
  shell?: ShellTarget;
  log?: (line: string) => void;
  onUserMessage?: (sessionId: string) => void;
  // Where a non-image attachment is written (`<root>/<sessionId>/…`); absent, files are refused.
  uploadsRoot?: string;
  // Answers only the socket the frame arrived on — a refused message is news to its sender alone
  reply?: (message: unknown) => void;
}

// Everything is parsed before anything is written or sent, so a bad attachment refuses the whole
// message. Files are written before the send, so a failed send leaves them in the session's uploads
// dir (and a retry writes them again); SessionStore.delete removes the dir with the session.
function userTurn(msg: Record<string, unknown>, sessionId: string, blocks: string, deps: SessionMessageDeps): TurnInput {
  const text = blocks + (typeof msg.content === 'string' ? msg.content : '');
  const attachments = parseAttachments(msg.attachments);
  if (attachments.some((a) => a.kind === 'file') && !deps.uploadsRoot) throw new Error('file uploads are not available');
  return buildTurnInput(text, attachments, deps.uploadsRoot ? makeUploadSaver(deps.uploadsRoot, sessionId) : () => '');
}

export function handleSessionMessage(raw: RawFrame, sessionId: string, deps: SessionMessageDeps): void {
  const msg = parseWsFrame(raw);
  if (!msg) return;
  const log = deps.log ?? (() => {});
  if (msg.type === 'user_message') {
    // `!` output the user produced since their last message rides in ahead of what they
    // typed — see SessionShell. Nothing is sent when they only ran commands, so the
    // blocks wait here rather than costing a turn of their own.
    const blocks = deps.shell?.drain(sessionId) ?? '';
    // Echoed on a refusal so the PWA can put that message back in the composer
    const clientId = typeof msg.clientId === 'string' && msg.clientId.length <= 64 ? msg.clientId : undefined;
    const refuse = (e: Error, reply = deps.reply) => {
      deps.shell?.restore(sessionId, blocks);
      log(`[api] user_message to ${sessionId.slice(0, 8)} refused: ${e.message}`);
      const frame = { type: 'daemon_error', message: `Message not sent — ${e.message}`, ...(clientId ? { clientId } : {}) };
      if (reply) reply(frame);
      else deps.manager.broadcast(sessionId, frame);
    };
    let turn: TurnInput;
    try {
      turn = userTurn(msg, sessionId, blocks, deps);
    } catch (e) {
      refuse(e as Error);
      return;
    }
    // A throw here would unwind through ws.on('message') and take the daemon down with every session.
    const deliver = () => {
      try {
        deps.manager.sendTurn(sessionId, turn);
        deps.onUserMessage?.(sessionId);
      } catch (e) {
        refuse(e as Error);
      }
    };
    if (deps.manager.isLive(sessionId)) deliver();
    // To every viewer: the sender may have reconnected on a new socket while the worktree was building.
    else deps.manager.wake(sessionId).then(deliver, (e: Error) => refuse(e, (f) => deps.manager.broadcast(sessionId, f)));
  } else if (msg.type === 'wake') {
    deps.manager.wake(sessionId).catch((e: Error) => {
      const frame = { type: 'daemon_error', message: e.message };
      if (deps.reply) deps.reply(frame);
      else deps.manager.broadcast(sessionId, frame);
    });
  } else if (msg.type === 'shell_exec') {
    const { execId, command } = msg as { execId?: string; command?: string };
    const shell = deps.shell;
    // After the wake, so a new worktree session runs in its worktree and the result reaches a live client.
    void deps.manager.wake(sessionId)
      .catch((e: Error) => log(`[api] wake for ${sessionId.slice(0, 8)} failed: ${e.message}`))
      .then(() => {
        if (!shell || typeof execId !== 'string' || typeof command !== 'string' || !command.trim()) return;
        return shell.run(sessionId, execId, command);
      })
      .catch((e: Error) => log(`[api] shell_exec in ${sessionId.slice(0, 8)} failed: ${e.message}`));
  } else if (msg.type === 'approval_decide') {
    const { approvalId, decision, reason } = msg as { approvalId: string; decision: 'allow' | 'deny'; reason?: string };
    deps.queue.decide(approvalId, { allow: decision === 'allow', reason });
  } else if (msg.type === 'interrupt') {
    log(`[api] interrupt requested for session ${sessionId.slice(0, 8)}`);
    try {
      deps.manager.interrupt(sessionId);
    } catch (e) {
      log(`[api] interrupt for ${sessionId.slice(0, 8)} failed: ${(e as Error).message}`);
    }
  } else if (msg.type === 'approval_mode_set') {
    const { mode } = msg as { mode?: string };
    if (typeof mode === 'string') {
      try {
        deps.modes.set(sessionId, mode as ApprovalMode);
        deps.manager.broadcast(sessionId, { type: 'approval_mode', sessionId, mode });
        log(`[api] approval mode for ${sessionId.slice(0, 8)} → ${mode}`);
      } catch {
        // Invalid mode — ignore.
      }
    }
  }
}
