import { randomUUID } from 'node:crypto';
import { AcpConnection } from './connection.js';
import type { AcpAgentConfig } from './config.js';
import { mapAcpUpdate, mergeToolCall, toolItem, type AcpSessionUpdate } from './events.js';
import { gateCallsFor, permissionReply, type AcpPermissionOption, type AcpToolCall, type GateCall, type PermissionReply } from './permission.js';
import { expandActionTurn } from '../action-turn.js';
import type { JsonlTranscripts } from '../jsonl-transcripts.js';
import type { McpServerConfig } from '../../integrations/mcp-config.js';
import type {
  AgentRuntime, CanonicalItem, RuntimeCapabilities, RuntimeHost, RuntimeId, RuntimeSession, StartCallbacks, StartOpts, TurnInput,
} from '../types.js';

// Reads mostly never ask, and an agent's MCP calls can't be shown to route through request_permission, so push stays refused.
export const ACP_CAPABILITIES: RuntimeCapabilities = {
  sessions: { supportsResume: true },
  streaming: { streamsAssistantText: true },
  tools: { supportsMcpTools: true, gatesMcpTools: false, gatesFileChanges: true, gatesAllCalls: false },
  subagents: { enabled: false },
  approvals: {
    supportsCommandApproval: true,
    supportsFileChangeApproval: true,
    approvalsCanOriginateFromSubagents: false,
    approvalCallbacksAreLiveOnly: true,
  },
  runtimePolicy: { enforcement: 'client-boundary' },
};

// Kinds an agent may run without asking; every other kind must have passed the gate first.
const UNGATED_KINDS = new Set(['read', 'search', 'think', 'switch_mode']);

const CANCELLED: PermissionReply = { outcome: { outcome: 'cancelled' } };

export interface AcpRuntimeOpts {
  agent: AcpAgentConfig;
  bin: string | null;
  host: () => RuntimeHost;
  mcpServers: () => Map<string, McpServerConfig>;
  transcripts: JsonlTranscripts;
  nativeIds: { read(sessionId: string): string | null; write(sessionId: string, nativeId: string): void };
  actionBody: (name: string) => string | undefined;
}

interface AgentCapabilities {
  loadSession?: boolean;
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  promptCapabilities?: { image?: boolean };
}

// An ACP agent behind Outpost's sessions, gated through session/request_permission.
export class AcpRuntime implements AgentRuntime {
  readonly id: RuntimeId;
  readonly capabilities = ACP_CAPABILITIES;
  readonly available: boolean;
  readonly transcripts: JsonlTranscripts;

  constructor(readonly opts: AcpRuntimeOpts) {
    this.id = `acp:${opts.agent.id}`;
    this.available = opts.bin !== null;
    this.transcripts = opts.transcripts;
  }

  start(s: StartOpts, cb: StartCallbacks): RuntimeSession {
    const session = new AcpSession(this.opts, s, cb);
    void session.boot();
    return session;
  }

  deliverActions(): void {}

  contextWindowHint(): number | null {
    return null;
  }
}

// One agent process holding one ACP session; turns sent before it is ready wait.
class AcpSession implements RuntimeSession {
  private conn: AcpConnection | undefined;
  private nativeId: string | undefined;
  private caps: AgentCapabilities = {};
  private ready = false;
  private loading = false;
  private inTurn = false;
  private interrupting = false;
  private prompted = false;
  private dead = false;
  private exitReported = false;
  private assistantText = '';
  private readonly queued: TurnInput[] = [];
  private readonly calls = new Map<string, AcpToolCall>();
  private readonly gated = new Map<string, GateCall[]>();
  private readonly settled = new Set<string>();

  constructor(private readonly o: AcpRuntimeOpts, private readonly s: StartOpts, private readonly cb: StartCallbacks) {}

  async boot(): Promise<void> {
    try {
      this.conn = new AcpConnection({
        command: this.o.bin!,
        args: this.o.agent.args,
        env: { ...process.env, ...this.o.agent.env, ...this.s.env },
        cwd: this.s.cwd,
        onNotification: (m, p) => this.onNotification(m, p),
        onRequest: (m, p) => this.onRequest(m, p),
        onStderr: (d) => this.cb.onError(d),
        onExit: (code) => this.onAgentExit(code),
      });
      const init = await this.conn.request<{ agentCapabilities?: AgentCapabilities }>('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'outpost', version: '0.1.0' },
      });
      this.caps = init.agentCapabilities ?? {};
      if (!this.caps.mcpCapabilities?.http) throw new Error("the agent can't reach Outpost's MCP server over HTTP");
      const mcpServers = this.mcpServers();
      const stored = this.s.mode === 'resume' ? this.o.nativeIds.read(this.s.sessionId) : null;
      let model: string | undefined;
      if (stored && this.caps.loadSession) {
        // session/load replays the history as updates; the transcript already holds it.
        this.loading = true;
        await this.conn.request('session/load', { sessionId: stored, cwd: this.s.cwd, mcpServers }, 120_000);
        this.loading = false;
        this.nativeId = stored;
        this.prompted = true;
      } else {
        if (this.s.mode === 'resume') this.cb.onError(`[acp] ${this.o.agent.id} can't resume sessions; continuing in a fresh one\n`);
        const r = await this.conn.request<{ sessionId: string; models?: { currentModelId?: string } }>(
          'session/new', { cwd: this.s.cwd, mcpServers }, 120_000,
        );
        this.nativeId = r.sessionId;
        model = r.models?.currentModelId;
      }
      this.o.nativeIds.write(this.s.sessionId, this.nativeId);
      this.cb.onEvent({ type: 'session.started', sessionId: this.s.sessionId, ...(model ? { model } : {}), mcpServers: [] });
      this.ready = true;
      this.startNextTurn();
    } catch (e) {
      this.refuse(`[acp] session refused: ${(e as Error).message}`);
    }
  }

  sendTurn(turn: TurnInput): void {
    if (this.dead) return;
    this.queued.push(turn);
    if (this.ready && !this.inTurn) this.startNextTurn();
  }

  interrupt(): void {
    if (!this.conn || !this.nativeId || !this.inTurn) return;
    this.interrupting = true;
    this.conn.notify('session/cancel', { sessionId: this.nativeId });
  }

  async kill(): Promise<void> {
    this.dead = true;
    this.releaseOpenPins();
    await this.conn?.kill();
  }

  private onAgentExit(code: number | null): void {
    if (this.dead) return;
    this.dead = true;
    this.queued.length = 0;
    this.releaseOpenPins();
    this.reportExit(code);
  }

  private releaseOpenPins(): void {
    for (const [id, calls] of this.gated) this.release(id, calls, true);
    this.gated.clear();
  }

  private release(toolUseId: string, calls: GateCall[], interrupted: boolean): void {
    const host = this.o.host();
    for (const g of calls) host.onToolFailed({ sessionId: this.s.sessionId, toolUseId, tool: g.tool, input: g.input, interrupted });
  }

  private mcpServers(): unknown[] {
    const pairs = (r: Record<string, string> | undefined) => Object.entries(r ?? {}).map(([name, value]) => ({ name, value }));
    const out: unknown[] = [];
    for (const [name, c] of this.o.mcpServers()) {
      if ((c.type === 'http' || c.type === 'sse') && c.url) {
        if (c.type === 'sse' && !this.caps.mcpCapabilities?.sse) continue;
        out.push({ type: c.type, name, url: c.url, headers: pairs(c.headers) });
      } else if (c.command) {
        out.push({ name, command: c.command, args: c.args ?? [], env: pairs(c.env) });
      }
    }
    return out;
  }

  private startNextTurn(): void {
    const turn = this.queued.shift();
    if (!turn || this.dead) return;
    this.inTurn = true;
    let text = expandActionTurn(turn.text, this.o.actionBody);
    if (!this.prompted && this.s.appendSystemPrompt) text = `${this.s.appendSystemPrompt}\n\n${text}`;
    this.prompted = true;
    const prompt: unknown[] = [{ type: 'text', text }];
    if (turn.images?.length) {
      if (this.caps.promptCapabilities?.image) {
        for (const img of turn.images) prompt.push({ type: 'image', mimeType: img.mediaType, data: img.data });
      } else {
        this.cb.onError(`[acp] ${this.o.agent.id} doesn't accept images, so they were dropped\n`);
      }
    }
    this.cb.onEvent({ type: 'turn.started' });
    this.record({ type: 'user_message', id: randomUUID(), text: turn.text });
    this.conn!.request<{ stopReason?: string }>('session/prompt', { sessionId: this.nativeId, prompt }, Infinity)
      .then((r) => this.endTurn(r.stopReason))
      .catch((e: Error) => { if (!this.dead) this.endTurn(undefined, e.message); });
  }

  private endTurn(stopReason: string | undefined, error?: string): void {
    this.flushAssistant();
    this.inTurn = false;
    this.interrupting = false;
    const host = this.o.host();
    if (error !== undefined) {
      this.cb.onEvent({ type: 'turn.completed', state: 'failed' });
      host.onTurnFailed(this.s.sessionId, 'acp_prompt_failed', error);
    } else if (stopReason === 'refusal') {
      this.cb.onEvent({ type: 'turn.completed', state: 'failed', stopReason });
      host.onTurnFailed(this.s.sessionId, 'refusal');
    } else {
      this.cb.onEvent({ type: 'turn.completed', state: stopReason === 'cancelled' ? 'cancelled' : 'completed', ...(stopReason ? { stopReason } : {}) });
      host.onTurnEnded(this.s.sessionId);
    }
    this.startNextTurn();
  }

  private onNotification(method: string, params: unknown): void {
    this.s.log?.native({ method, params });
    if (method !== 'session/update' || this.loading || this.dead) return;
    const p = params as { sessionId?: string; update?: AcpSessionUpdate } | null;
    if (!p?.update || p.sessionId !== this.nativeId) return;
    const u = p.update;
    const isToolUpdate = u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update';
    if (isToolUpdate) {
      const id = (u as AcpToolCall).toolCallId;
      if (u.sessionUpdate === 'tool_call_update' && this.settled.has(id)) return;
      this.settled.delete(id);
    }
    if (u.sessionUpdate === 'tool_call') this.flushAssistant();
    const events = mapAcpUpdate(u, this.calls, this.o.agent);
    if (isToolUpdate) {
      const call = this.calls.get((u as AcpToolCall).toolCallId)!;
      if (this.ranUngated(call)) return this.tripwire(`${call.kind ?? 'unclassified'} call ${call.toolCallId}`);
      if (call.status === 'completed' || call.status === 'failed') this.settle(call);
    }
    if (u.sessionUpdate === 'agent_message_chunk') this.assistantText += (u as { content: { text?: string } }).content?.text ?? '';
    for (const e of events) this.cb.onEvent(e);
  }

  // The tripwire fires only after the call has run; it stops the session, it can't undo the call.
  private ranUngated(call: AcpToolCall): boolean {
    if (call.kind && UNGATED_KINDS.has(call.kind)) return false;
    if (call.status !== 'in_progress' && call.status !== 'completed') return false;
    return !this.gated.has(call.toolCallId);
  }

  private settle(call: AcpToolCall): void {
    this.settled.add(call.toolCallId);
    this.calls.delete(call.toolCallId);
    this.record(toolItem(call, this.o.agent));
    const seen = this.gated.get(call.toolCallId);
    if (!seen) return;
    this.gated.delete(call.toolCallId);
    const exit = (call.rawOutput as { exitCode?: unknown } | null | undefined)?.exitCode;
    if (call.status === 'failed' || (typeof exit === 'number' && exit !== 0)) {
      return this.release(call.toolCallId, seen, this.interrupting);
    }
    const host = this.o.host();
    for (const g of seen) {
      if (g.tool === 'shell' || g.tool.startsWith('mcp:')) {
        host.onToolCompleted({ sessionId: this.s.sessionId, tool: g.tool, rawName: g.rawName, input: g.input, response: call.rawOutput });
      }
    }
  }

  private async onRequest(method: string, params: unknown): Promise<PermissionReply> {
    if (method !== 'session/request_permission') throw new Error(`Outpost does not answer ${method}`);
    const p = params as { sessionId?: string; toolCall?: AcpToolCall; options?: AcpPermissionOption[] };
    const options = p.options ?? [];
    if (this.dead || this.interrupting) return CANCELLED;
    if (p.sessionId !== this.nativeId || !p.toolCall?.toolCallId) return permissionReply(options, false);
    if (!options.some((o) => o.kind === 'allow_once')) return this.deny(options, 'The agent offered no one-time approval, so Outpost refused the call.');
    this.settled.delete(p.toolCall.toolCallId);
    const call = mergeToolCall(this.calls, p.toolCall);
    const gateCalls = gateCallsFor(call, this.s.cwd, this.o.agent);
    if ('deny' in gateCalls) return this.deny(options, gateCalls.deny);
    const allowed: GateCall[] = [];
    for (const g of gateCalls) {
      let reason: string | undefined;
      try {
        const d = await this.o.host().gateToolCall({ sessionId: this.s.sessionId, toolUseId: call.toolCallId, ...g });
        if (!d.allow) reason = d.reason || 'Outpost denied this call.';
      } catch {
        reason = 'Outpost could not decide on this call, so it was refused.';
      }
      if (reason !== undefined) {
        this.release(call.toolCallId, allowed, false);
        return this.deny(options, reason);
      }
      allowed.push(g);
    }
    if (this.dead || this.interrupting) {
      this.release(call.toolCallId, allowed, true);
      return CANCELLED;
    }
    this.gated.set(call.toolCallId, gateCalls);
    return permissionReply(options, true);
  }

  private deny(options: AcpPermissionOption[], reason: string): PermissionReply {
    this.cb.onError(`[acp] ${reason}\n`);
    return permissionReply(options, false);
  }

  private flushAssistant(): void {
    if (!this.assistantText) return;
    const item: CanonicalItem = { type: 'assistant_message', id: randomUUID(), text: this.assistantText };
    this.assistantText = '';
    this.cb.onEvent({ type: 'item.completed', item });
    this.record(item);
  }

  private record(item: CanonicalItem): void {
    this.o.transcripts.append(this.s.sessionId, this.s.cwd, item);
  }

  private tripwire(what: string): void {
    if (this.nativeId) this.conn?.notify('session/cancel', { sessionId: this.nativeId });
    this.refuse(`[acp] ${what} ran without passing Outpost's permission gate; the session was stopped`);
    this.o.host().onTurnFailed(this.s.sessionId, 'ungated_tool_call', what);
  }

  private refuse(msg: string): void {
    this.cb.onError(`${msg}\n`);
    this.queued.length = 0;
    void this.kill().then(() => this.reportExit(1));
  }

  private reportExit(code: number | null): void {
    if (this.exitReported) return;
    this.exitReported = true;
    this.cb.onExit(code);
  }
}
