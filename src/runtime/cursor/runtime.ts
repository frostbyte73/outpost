import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cursorDeny, CURSOR_ALLOW, hooksIntact, hooksJson, installHooks } from './hooks.js';
import { hookDecisionInput, type CursorHookPayload } from './decide.js';
import { AcpSession, type AcpRuntimeOpts, type AcpSessionPolicy } from '../acp/runtime.js';
import type { AcpAgentConfig } from '../acp/config.js';
import { mcpToolName, permissionReply, type AcpPermissionOption, type AcpToolCall, type GateCall } from '../acp/permission.js';
import type { JsonlTranscripts } from '../jsonl-transcripts.js';
import type { McpServerConfig } from '../../integrations/mcp-config.js';
import type { AgentRuntime, RuntimeCapabilities, RuntimeHost, RuntimeSession, StartCallbacks, StartOpts } from '../types.js';

export interface CursorRuntimeOpts {
  bin: string | null;
  host: () => RuntimeHost;
  mcpServers: () => Map<string, McpServerConfig>;
  approvalTimeoutMs: number;
  daemonAuthSecret: string;
  hookPort: number;
  runtimeDir: string;
  transcripts: JsonlTranscripts;
  nativeIds: AcpRuntimeOpts['nativeIds'];
  actionBody: (name: string) => string | undefined;
}

// Image generation reaches no hook and no permission request (runtime-cursor-live.test.ts, D6), so push stays refused.
const CAPABILITIES: RuntimeCapabilities = {
  sessions: { supportsResume: true },
  streaming: { streamsAssistantText: true },
  tools: { supportsMcpTools: true, gatesMcpTools: true, gatesFileChanges: true, gatesAllCalls: false },
  subagents: { enabled: false },
  approvals: {
    supportsCommandApproval: true,
    supportsFileChangeApproval: true,
    approvalsCanOriginateFromSubagents: false,
    approvalCallbacksAreLiveOnly: true,
  },
  runtimePolicy: { enforcement: 'client-boundary' },
};

const NO_IO_KINDS: ReadonlySet<string> = new Set(['think', 'switch_mode']);

const TOOL_CALL_WAIT_MS = 2_000;

type Decision = { allow: true; calls: GateCall[] } | { allow: false; reason: string };

// Shell and MCP hooks carry no ACP id, so their calls are matched to the hook's decision by content, oldest first.
interface CursorSessionState {
  cwd: string;
  dataDir: string;
  session: AcpSession;
  decisions: Map<string, Promise<Decision>>;
  allowedByContent: Map<string, GateCall[][]>;
  deniedByContent: Map<string, number>;
  deciding: number;
}

// Cursor's `agent acp` behind Outpost's sessions, gated by fail-closed hooks in a per-session data dir.
export class CursorRuntime implements AgentRuntime {
  readonly id = 'cursor';
  readonly capabilities = CAPABILITIES;
  readonly available: boolean;
  readonly transcripts: JsonlTranscripts;
  private readonly sessions = new Map<string, CursorSessionState>();
  private readonly hookTimeoutSec: number;
  private readonly agent: AcpAgentConfig;

  constructor(readonly opts: CursorRuntimeOpts) {
    this.available = opts.bin !== null;
    this.transcripts = opts.transcripts;
    this.hookTimeoutSec = Math.ceil(opts.approvalTimeoutMs / 1000) + 60;
    this.agent = {
      id: 'cursor', command: opts.bin ?? 'agent', args: ['acp'], env: {},
      mcpTitlePattern: '^(?<server>[\\w-]+)-(?<tool>[\\w-]+): \\k<tool>$', shellCommandField: 'command', authMethodId: 'cursor_login',
    };
  }

  start(s: StartOpts, cb: StartCallbacks): RuntimeSession {
    const session = new AcpSession(
      { agent: this.agent, bin: this.opts.bin, host: this.opts.host, mcpServers: this.opts.mcpServers, transcripts: this.transcripts,
        nativeIds: this.opts.nativeIds, actionBody: this.opts.actionBody },
      s, cb, (sess) => this.policy(sess, s),
    );
    void session.boot();
    return session;
  }

  deliverActions(): void {}

  contextWindowHint(): number | null {
    return null;
  }

  // The hook endpoint's body for one Cursor hook call: CURSOR_ALLOW or a deny the script passes through.
  async handleHook(body: string, sessionId: string | undefined): Promise<string> {
    let p: CursorHookPayload;
    try { p = JSON.parse(body) as CursorHookPayload; } catch { return cursorDeny('Outpost could not read this hook call.'); }
    const state = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!state) return cursorDeny('This Cursor session is not one Outpost started, so the call was not run.');
    if (!state.session.admitsTools()) return cursorDeny('This session is stopping, so the call was not run.');
    const fileHook = p.hook_event_name === 'preToolUse' && (p.tool_name === 'Read' || p.tool_name === 'Write');
    // Every preToolUse hook but Shell's carries the ACP toolCallId, so its decision is recorded straight against that call.
    const acpId = p.hook_event_name === 'preToolUse' && p.tool_name !== 'Shell' ? p.tool_use_id : undefined;
    // Cursor ignores a Write-hook deny, so recording one would hide a write that lands anyway from the tripwire.
    const record = (allowed: GateCall[] | undefined) => {
      if (acpId && (allowed || p.tool_name !== 'Write')) state.session.noteDecision(acpId, allowed);
    };
    const acpCall = p.tool_use_id ? await state.session.toolCall(p.tool_use_id, fileHook ? TOOL_CALL_WAIT_MS : 0) : undefined;
    // Without its tool_call a Read can't be told from an edit's Read, and only that one stops the edit.
    if (fileHook && !acpCall) {
      record(undefined);
      return cursorDeny('Outpost could not match this file call to the agent\'s tool call, so it was not run.');
    }
    const input = hookDecisionInput(p, state, acpCall?.kind === 'edit');
    if ('deny' in input) {
      record(undefined);
      return cursorDeny(input.deny);
    }
    let pending = state.decisions.get(input.key);
    const fresh = !pending;
    if (!pending) {
      pending = this.gate(sessionId!, { ...input.call, gateId: p.tool_use_id });
      state.decisions.set(input.key, pending);
    }
    state.deciding++;
    const d = await pending.finally(() => { state.deciding--; });
    if (fresh && input.contentKey) {
      if (d.allow) state.allowedByContent.set(input.contentKey, [...(state.allowedByContent.get(input.contentKey) ?? []), d.calls]);
      else state.deniedByContent.set(input.contentKey, (state.deniedByContent.get(input.contentKey) ?? 0) + 1);
    }
    record(d.allow ? d.calls : undefined);
    return d.allow ? CURSOR_ALLOW : cursorDeny(d.reason);
  }

  private async gate(sessionId: string, call: GateCall): Promise<Decision> {
    try {
      const d = await this.opts.host().gateToolCall({ sessionId, toolUseId: call.gateId, tool: call.tool, rawName: call.rawName, input: call.input });
      return d.allow ? { allow: true, calls: [call] } : { allow: false, reason: d.reason || 'Outpost denied this call.' };
    } catch {
      return { allow: false, reason: 'Outpost could not decide on this call, so it was not run.' };
    }
  }

  private policy(session: AcpSession, s: StartOpts): AcpSessionPolicy {
    const dataDir = join(this.opts.runtimeDir, 'cursor', s.sessionId);
    const configDir = join(dataDir, 'config');
    const hooks = hooksJson(this.hookTimeoutSec);
    const state: CursorSessionState = {
      cwd: s.cwd, dataDir, session, decisions: new Map(), allowedByContent: new Map(), deniedByContent: new Map(), deciding: 0,
    };
    return {
      env: {
        DAEMON_AUTH: this.opts.daemonAuthSecret,
        OUTPOST_HOOK_PORT: String(this.opts.hookPort),
        OUTPOST_HOOK_CURL_TIMEOUT_S: String(this.hookTimeoutSec - 30),
        OUTPOST_CURSOR_SESSION: s.sessionId,
        CURSOR_DATA_DIR: dataDir,
        CURSOR_CONFIG_DIR: configDir,
      },
      ungatedKinds: NO_IO_KINDS,
      beforeBoot: () => {
        mkdirSync(configDir, { recursive: true, mode: 0o700 });
        state.dataDir = realpathSync(dataDir);
        installHooks(dataDir, s.cwd, hooks);
        writeFileSync(join(configDir, 'cli-config.json'), `${JSON.stringify(forcedPrompts(userCliConfig()), null, 2)}\n`, { mode: 0o600 });
        this.sessions.set(s.sessionId, state);
      },
      beforeTurn: () => {
        if (!hooksIntact(dataDir, s.cwd, hooks)) throw new Error("Outpost's Cursor hooks file was changed or removed");
      },
      answerPermission: (call, options) => this.answerPermission(state, call, options),
      claimDenied: (call) => {
        const key = contentKey(call.title, this.agent);
        const n = key ? state.deniedByContent.get(key) ?? 0 : 0;
        if (n === 0) return false;
        state.deniedByContent.set(key!, n - 1);
        return true;
      },
      hasPendingTools: () => state.deciding > 0 || [...state.allowedByContent.values()].some((calls) => calls.length > 0),
      onEnd: () => {
        this.sessions.delete(s.sessionId);
        const host = this.opts.host();
        for (const g of [...state.allowedByContent.values()].flat(2)) {
          host.onToolFailed({ sessionId: s.sessionId, toolUseId: g.gateId, tool: g.tool, input: g.input, interrupted: true });
        }
        state.allowedByContent.clear();
      },
    };
  }

  // Requests come after the hook that decided the call, so they replay that decision and never reach the gate.
  private answerPermission(state: CursorSessionState, call: AcpToolCall, options: AcpPermissionOption[]) {
    const key = contentKey(call.title, this.agent);
    const allowed = key ? state.allowedByContent.get(key)?.shift() : undefined;
    return allowed ? { reply: permissionReply(options, true), allowed } : { reply: permissionReply(options, false) };
  }
}

function forcedPrompts(user: Record<string, unknown>): Record<string, unknown> {
  const permissions = user.permissions && typeof user.permissions === 'object' ? user.permissions : {};
  return { ...user, approvalMode: 'allowlist', permissions: { ...permissions, allow: [] }, autoAcceptWebSearch: false };
}

function contentKey(title: string | undefined, agent: AcpAgentConfig): string | undefined {
  if (!title) return undefined;
  const shell = /^`([\s\S]*)`$/.exec(title);
  if (shell) return `shell:${shell[1]}`;
  const web = /^Web search: ([\s\S]*)$/.exec(title);
  if (web) return `web_search:${web[1]}`;
  return mcpToolName(title, agent);
}

function userCliConfig(): Record<string, unknown> {
  const path = join(homedir(), '.cursor', 'cli-config.json');
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { return {}; }
}
