import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServer } from './app-server.js';
import { CallTracker } from './call-tracker.js';
import { mapCodexNotification } from './events.js';
import {
  featuresStillOn, findOutpostHook, trustVerdict,
  type ExperimentalFeatureListResponse, type HookTrust, type HooksListResponse, type TrustVerdict,
} from './hook-trust.js';
import { isToolItem, mcpRawName, toCanonicalItem, unwrappedCommand, type CodexItem } from './items.js';
import { decideCodexPreTool, type CodexPreToolPayload } from './pretool.js';
import { PRETOOL_HOOK_COMMAND } from './pretool-hook.js';
import { codexConfigArgs, REQUIRED_OFF_FEATURES } from './thread-config.js';
import { codexCanonicalTool } from './tools.js';
import { expandActionTurn } from '../action-turn.js';
import { isHandoffSeed } from '../../session/handoff-seed.js';
import type { JsonlTranscripts } from '../jsonl-transcripts.js';
import type { McpServerConfig } from '../../integrations/mcp-config.js';
import type {
  AgentRuntime, FirstTurnSeed, RuntimeCapabilities, RuntimeHost, RuntimeSession, StartCallbacks, StartOpts, TurnInput,
} from '../types.js';

export interface CodexRuntimeOpts {
  bin: string | null;
  host: () => RuntimeHost;
  mcpServers: () => Map<string, McpServerConfig>;
  approvalTimeoutMs: number;
  daemonAuthSecret: string;
  hookPort: number;
  transcripts: JsonlTranscripts;
  nativeIds: { read(sessionId: string): string | null; write(sessionId: string, threadId: string): void };
  actionBody: (name: string) => string | undefined;
}

const CAPABILITIES: RuntimeCapabilities = {
  sessions: { supportsResume: true },
  streaming: { streamsAssistantText: true },
  tools: { supportsMcpTools: true, gatesMcpTools: true, gatesFileChanges: true, gatesAllCalls: true },
  subagents: { enabled: false },
  approvals: {
    supportsCommandApproval: true,
    supportsFileChangeApproval: true,
    approvalsCanOriginateFromSubagents: false,
    approvalCallbacksAreLiveOnly: true,
  },
  runtimePolicy: { enforcement: 'client-boundary' },
};

interface ThreadStartResult { thread: { id: string }; model: string }

// OpenAI Codex behind Outpost's sessions, driven through `codex app-server` and gated by a PreToolUse hook.
export class CodexRuntime implements AgentRuntime {
  readonly id = 'codex';
  readonly capabilities = CAPABILITIES;
  readonly available: boolean;
  readonly transcripts: JsonlTranscripts;
  private trust: HookTrust | undefined;
  private readonly threads = new Map<string, { sessionId: string; cwd: string; tracker: CallTracker; canStartTool?: () => boolean }>();
  private readonly hookTimeoutSec: number;

  constructor(readonly opts: CodexRuntimeOpts) {
    this.available = opts.bin !== null;
    this.transcripts = opts.transcripts;
    this.hookTimeoutSec = Math.ceil(opts.approvalTimeoutMs / 1000) + 60;
  }

  start(s: StartOpts, cb: StartCallbacks): RuntimeSession {
    const session = new CodexSession(this, s, cb);
    void session.boot();
    return session;
  }

  deliverActions(): void {}

  contextWindowHint(): number | null {
    return null;
  }

  // The hook endpoint's body for one PreToolUse call: `{"decision":"allow"}` or `deny:<reason>`.
  async handlePreToolUse(body: string): Promise<string> {
    let p: CodexPreToolPayload;
    try { p = JSON.parse(body) as CodexPreToolPayload; } catch { return 'deny:Outpost could not read this hook call.'; }
    const thread = this.threads.get(p.session_id);
    if (thread?.canStartTool?.() === false) return 'deny:Runtime switch in progress';
    if (thread) thread.tracker.pendingDecisions++;
    try {
      const d = await decideCodexPreTool(p, () => thread, (req) => this.opts.host().gateToolCall(req));
      if (!d.allow) {
        thread?.tracker.noteDenied(p.tool_use_id);
        return `deny:${d.reason || 'Outpost denied this call.'}`;
      }
      thread!.tracker.noteGated(p.tool_use_id, codexCanonicalTool(p.tool_name), p.tool_input);
      return '{"decision":"allow"}';
    } finally {
      if (thread) thread.tracker.pendingDecisions--;
    }
  }

  spawnServer(cwd: string, env: Record<string, string>, handlers: {
    onNotification: (method: string, params: unknown) => void; onStderr: (s: string) => void; onExit: (code: number | null) => void;
  }, launchCredential?: string): CodexAppServer {
    const mcpServers = this.opts.mcpServers();
    const outpost = mcpServers.get('outpost');
    if (launchCredential && outpost?.type === 'http') {
      mcpServers.set('outpost', { ...outpost, headers: { ...outpost.headers, 'X-Outpost-Launch': launchCredential } });
    }
    const config = codexConfigArgs({
      hookTimeoutSec: this.hookTimeoutSec,
      ...(this.trust ? { trust: this.trust } : {}),
      mcpServers,
    });
    return new CodexAppServer({
      bin: this.opts.bin!,
      args: ['app-server', ...config.args],
      env: {
        ...process.env,
        ...config.env,
        DAEMON_AUTH: this.opts.daemonAuthSecret,
        OUTPOST_HOOK_PORT: String(this.opts.hookPort),
        OUTPOST_HOOK_CURL_TIMEOUT_S: String(this.hookTimeoutSec - 30),
        ...env,
      },
      cwd,
      ...handlers,
    });
  }

  // The hook's command string is fixed for a daemon launch, so the hash learned from one thread trusts all of them.
  verifyHook(list: HooksListResponse): TrustVerdict {
    const h = findOutpostHook(list, PRETOOL_HOOK_COMMAND);
    const verdict = trustVerdict(h, this.hookTimeoutSec);
    if (verdict === 'needs-trust' && h && !this.trust) this.trust = { key: h.key, hash: h.currentHash };
    return verdict;
  }

  register(threadId: string, thread: { sessionId: string; cwd: string; tracker: CallTracker; canStartTool?: () => boolean }): void {
    this.threads.set(threadId, thread);
  }

  unregister(threadId: string): void {
    this.threads.delete(threadId);
  }
}

// One Codex thread on its own app-server process; turns sent before the hook is verified wait.
class CodexSession implements RuntimeSession {
  private server: CodexAppServer | undefined;
  private threadId: string | undefined;
  private turnId: string | undefined;
  private model: string | undefined;
  private ready = false;
  private inTurn = false;
  private dead = false;
  private exitReported = false;
  private readonly queued: { turn: TurnInput; seed?: FirstTurnSeed }[] = [];
  private seedToken?: string;
  private seededText?: string;
  private prepareRestartSeed?: (queuedSeed?: FirstTurnSeed) => FirstTurnSeed;
  // A turn/start response can land after its turn ended; its id must not become the live turn's.
  private readonly endedTurns = new Set<string>();
  private readonly tracker = new CallTracker();
  private imageSeq = 0;

  constructor(private readonly rt: CodexRuntime, private readonly s: StartOpts, private readonly cb: StartCallbacks) {}

  async boot(): Promise<void> {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const verdict = await this.startThread();
        if (verdict === 'trusted') break;
        if (verdict === 'needs-trust' && attempt === 0) continue;
        throw new Error(typeof verdict === 'object' ? verdict.refuse : "Codex left Outpost's PreToolUse hook untrusted");
      }
      const features = await this.listFeatures();
      const stillOn = featuresStillOn(features, REQUIRED_OFF_FEATURES);
      if (stillOn.length > 0) throw new Error(`Codex did not disable ${stillOn.join(', ')}, which Outpost's gate needs off`);
      if (this.dead || this.s.acceptsCallbacks?.() === false) return;
      if (this.s.saveNativeId) this.s.saveNativeId(this.threadId!);
      else this.rt.opts.nativeIds.write(this.s.sessionId, this.threadId!);
      this.cb.onEvent({ type: 'session.started', sessionId: this.s.sessionId, ...(this.model ? { model: this.model } : {}), mcpServers: [] });
      this.ready = true;
      this.startNextTurn();
    } catch (e) {
      this.refuse(`[codex] session refused: ${(e as Error).message}`);
    }
  }

  // A turn sent while one is running waits for it to end, as a Claude session's follow-ups do.
  sendTurn(turn: TurnInput, seed?: FirstTurnSeed): void {
    if (this.dead) return;
    this.queued.push({ turn, seed });
    if (this.ready && !this.inTurn) this.startNextTurn();
  }

  private startNextTurn(): void {
    const next = this.queued.shift();
    if (!next || this.dead) return;
    const { turn } = next;
    const seed = this.prepareRestartSeed?.(next.seed) ?? next.seed;
    this.prepareRestartSeed = undefined;
    this.inTurn = true;
    const text = expandActionTurn(turn.text, this.rt.opts.actionBody);
    const input: unknown[] = [{ type: 'text', text, text_elements: [] }];
    if (seed) {
      this.seedToken = seed.token;
      this.seededText = turn.text;
      input.push({ type: 'text', text: seed.block, text_elements: [] });
    }
    for (const img of turn.images ?? []) input.push({ type: 'localImage', path: this.writeImage(img) });
    this.server!.request<{ turn: { id: string } }>('turn/start', { threadId: this.threadId, input }, Infinity)
      .then((res) => {
        if (this.dead || this.s.acceptsCallbacks?.() === false) return;
        if (seed) this.cb.onSeedAccepted?.(seed.token);
        if (turn.deliveryId) turn.onAccepted?.(turn.deliveryId);
        if (this.inTurn && !this.endedTurns.has(res.turn.id)) this.turnId ??= res.turn.id;
      })
      .catch((e: Error & { rpcCode?: number }) => {
        if (this.dead) return;
        if (seed) {
          if (e.rpcCode === -32601 || e.rpcCode === -32602) this.cb.onSeedRejected?.(seed.token);
          else this.cb.onSeedUncertain?.(seed.token);
        }
        this.cb.onError(`[codex] turn/start failed: ${e.message}\n`);
        this.inTurn = false;
        if (this.s.canStartTool?.() !== false) this.rt.opts.host().onTurnFailed(this.s.sessionId, 'codex_turn_start_failed', e.message);
        this.startNextTurn();
      });
  }

  interrupt(): void {
    if (!this.server || !this.threadId || !this.turnId) return;
    this.tracker.noteInterruptRequested(this.turnId);
    this.server.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })
      .catch((e: Error) => this.cb.onError(`[codex] interrupt failed: ${e.message}`));
  }

  hasPendingTools(): boolean { return this.tracker.hasPendingCalls; }

  async kill(): Promise<void> {
    this.dead = true;
    if (this.threadId) this.rt.unregister(this.threadId);
    rmSync(this.imageDir(), { recursive: true, force: true });
    await this.server?.kill();
  }

  // Starts (or resumes) the thread on a fresh process and reports what Codex says about Outpost's hook.
  private async startThread(): Promise<TrustVerdict> {
    if (this.server) {
      const old = this.server;
      this.server = undefined;
      if (this.threadId) this.rt.unregister(this.threadId);
      await old.kill();
    }
    const server = this.rt.spawnServer(this.s.cwd, this.s.env, {
      onNotification: (m, p) => this.onNotification(m, p),
      onStderr: (d) => this.cb.onError(d),
      onExit: (code) => { if (this.server === server && !this.dead) this.reportExit(code); },
    }, this.s.launchCredential);
    this.server = server;
    await server.initialize();
    const native = this.s.mode === 'resume'
      ? this.s.nativeId ?? this.rt.opts.nativeIds.read(this.s.sessionId) : null;
    const params = {
      cwd: this.s.cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ...(this.s.appendSystemPrompt ? { developerInstructions: this.s.appendSystemPrompt } : {}),
    };
    let started: ThreadStartResult;
    if (native) {
      try {
        started = await server.request<ThreadStartResult>('thread/resume', { threadId: native, ...params });
      } catch (error) {
        if (!this.s.newTranscriptSegment || !/(thread|rollout).*(not found|does not exist|no such file)/i.test((error as Error).message)) throw error;
        const { id, prepareSeed } = this.s.newTranscriptSegment();
        this.s.transcriptId = id;
        this.s.mode = 'new';
        this.prepareRestartSeed = prepareSeed;
        started = await server.request<ThreadStartResult>('thread/start', params);
      }
    } else {
      started = await server.request<ThreadStartResult>('thread/start', params);
    }
    this.threadId = started.thread.id;
    this.model = started.model;
    if (this.dead) throw new Error('Session was closed');
    this.rt.register(this.threadId, { sessionId: this.s.sessionId, cwd: this.s.cwd, tracker: this.tracker, canStartTool: this.s.canStartTool });
    return this.rt.verifyHook(await server.request<HooksListResponse>('hooks/list', { threadId: this.threadId }));
  }

  private async listFeatures(): Promise<ExperimentalFeatureListResponse['data']> {
    const out: ExperimentalFeatureListResponse['data'] = [];
    let cursor: string | null = null;
    do {
      const page: ExperimentalFeatureListResponse = await this.server!.request('experimentalFeature/list', {
        threadId: this.threadId, ...(cursor ? { cursor } : {}),
      });
      out.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  private onNotification(method: string, params: unknown): void {
    if (this.dead || this.s.acceptsCallbacks?.() === false) return;
    const p = params as { threadId?: string; turnId?: string; turn?: { id: string; status: string; error?: { message?: string; codexErrorInfo?: unknown } | null }; item?: CodexItem };
    if (p?.threadId && p.threadId !== this.threadId) return;
    if (p?.item?.type === 'userMessage' && 'content' in p.item && this.seedToken
      && p.item.content.some((part) => isHandoffSeed(part.text, this.seedToken))) {
      p.item = { ...p.item, content: [
        { type: 'text', text: this.seededText },
        ...p.item.content.filter((part) => part.type !== 'text'),
      ] };
    }
    if (!this.seedToken || (method !== 'turn/started' && method !== 'turn/completed')) this.s.log?.native({ method, params });
    if ((method === 'item/started' || method === 'item/completed') && p.item) {
      const ungated = this.tracker.ungatedCall(p.item);
      if (ungated) return this.tripwire(ungated);
    }
    if (method === 'item/completed' && p.item) this.onItemCompleted(p.item, p.turnId ?? '');
    if (method === 'turn/started' && p.turn) this.turnId = p.turn.id;
    for (const e of mapCodexNotification(method, params, this.model)) this.cb.onEvent(e);
    if (method === 'turn/completed' && p.turn) this.onTurnCompleted(p.turn);
  }

  private onItemCompleted(item: CodexItem, turnId: string): void {
    const host = this.rt.opts.host();
    const release = this.tracker.releaseFor(item, turnId);
    if (release) host.onToolFailed({ sessionId: this.s.sessionId, ...release });
    else if (isToolItem(item) && item.status === 'completed' && item.type !== 'fileChange') {
      const rawName = item.type === 'commandExecution' ? 'Bash' : mcpRawName(item);
      host.onToolCompleted({
        sessionId: this.s.sessionId,
        tool: codexCanonicalTool(rawName),
        rawName,
        input: item.type === 'commandExecution' ? { command: unwrappedCommand(item.command) } : item.arguments,
        response: item.type === 'commandExecution' ? { stdout: item.aggregatedOutput ?? '' } : item.result,
      });
    }
    const canonical = toCanonicalItem(item);
    if (canonical) this.rt.transcripts.append(this.s.transcriptId ?? this.s.sessionId, this.s.cwd, canonical);
  }

  private onTurnCompleted(turn: { id: string; status: string; error?: { message?: string; codexErrorInfo?: unknown } | null }): void {
    this.endedTurns.add(turn.id);
    this.turnId = undefined;
    this.inTurn = false;
    this.seedToken = undefined;
    this.seededText = undefined;
    const host = this.rt.opts.host();
    if (this.s.canStartTool?.() !== false) {
      if (turn.status !== 'failed') host.onTurnEnded(this.s.sessionId);
      else host.onTurnFailed(this.s.sessionId, turnErrorCode(turn.error?.codexErrorInfo), turn.error?.message);
    }
    this.startNextTurn();
  }

  // A tool ran that Outpost's hook never saw, so nothing this session does next can be trusted.
  private tripwire(what: string): void {
    this.interrupt();
    this.refuse(`[codex] ${what} ran without passing Outpost's permission gate; the session was stopped`);
    this.rt.opts.host().onTurnFailed(this.s.sessionId, 'ungated_tool_call', what);
  }

  private refuse(msg: string): void {
    this.cb.onError(`${msg}\n`);
    this.queued.length = 0;
    void this.kill().then(() => this.reportExit(1));
  }

  // A server that dies mid-boot reports its exit, then boot's catch refuses: the session must still exit once.
  private reportExit(code: number | null): void {
    if (this.exitReported) return;
    this.exitReported = true;
    this.cb.onExit(code);
  }

  private imageDir(): string {
    return join(tmpdir(), 'outpost-codex', this.s.sessionId);
  }

  private writeImage(img: { mediaType: string; data: string }): string {
    const dir = this.imageDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${this.imageSeq++}.${img.mediaType.split('/')[1] ?? 'png'}`);
    writeFileSync(path, Buffer.from(img.data, 'base64'), { mode: 0o600 });
    return path;
  }
}

function turnErrorCode(info: unknown): string {
  const name = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : undefined;
  if (name === 'unauthorized') return 'authentication_failed';
  return name ? name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) : 'codex_turn_failed';
}
