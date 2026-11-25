import type { McpServerConfig, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { join } from 'node:path';
import { ClaudeSdkSession } from './sdk-session.js';
import { StreamJsonMapper } from './events.js';
import { StatuslineSynth } from './usage.js';
import { claudeHooks } from './hooks.js';
import { sdkExecutable } from './bin.js';
import { deliverActionsAsSkills } from './skills.js';
import { readProjectContextWindow } from './config.js';
import { hasClaudeUserRecord } from './transcript-parse.js';
import { isHandoffSeed } from '../../session/handoff-seed.js';
import type {
  AgentRuntime, RuntimeCapabilities, RuntimeHost, RuntimeSession, StartCallbacks, StartOpts, TranscriptReader, TurnInput,
} from '../types.js';

export interface ClaudeRuntimeOpts {
  // Late-bound: the host needs the SessionManager, which needs this runtime.
  host: () => RuntimeHost;
  mcpServers: Record<string, McpServerConfig>;
  approvalTimeoutMs: number;
  daemonAuthSecret: string;
  daemonHost: string;
  hookPort: number;
  transcripts: TranscriptReader;
}

const CAPABILITIES: RuntimeCapabilities = {
  sessions: { supportsResume: true },
  streaming: { streamsAssistantText: true },
  tools: { supportsMcpTools: true, gatesMcpTools: true, gatesFileChanges: true, gatesAllCalls: true },
  subagents: { enabled: true },
  approvals: {
    supportsCommandApproval: true,
    supportsFileChangeApproval: true,
    approvalsCanOriginateFromSubagents: true,
    approvalCallbacksAreLiveOnly: true,
  },
  runtimePolicy: { enforcement: 'client-boundary' },
};

// The user message for one turn of a streaming-input session.
export function toUserFrame(turn: TurnInput, sessionId: string, seed?: string): SDKUserMessage {
  const images = turn.images ?? [];
  const content = images.length === 0 && !seed ? turn.text : [
    ...images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType as 'image/png', data: i.data } })),
    // The API rejects an empty text block, so a photo sent on its own carries none.
    ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
    ...(seed ? [{ type: 'text' as const, text: seed }] : []),
  ];
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: sessionId, uuid: turn.deliveryId } as SDKUserMessage;
}

// Claude Code behind Outpost's sessions, driven through the Agent SDK and gated by in-process hooks.
export class ClaudeRuntime implements AgentRuntime {
  readonly id = 'claude';
  readonly capabilities = CAPABILITIES;
  readonly available = true;
  readonly transcripts: TranscriptReader;

  constructor(private readonly opts: ClaudeRuntimeOpts) {
    this.transcripts = opts.transcripts;
  }

  start(s: StartOpts, cb: StartCallbacks): RuntimeSession {
    const mapper = new StreamJsonMapper();
    const usage = new StatuslineSynth();
    const host = this.opts.host();
    const nativeId = s.nativeId ?? s.transcriptId ?? s.sessionId;
    const logical = (id: string) => id === nativeId ? s.sessionId : id;
    const current = () => s.acceptsCallbacks?.() !== false;
    let seedToken: string | undefined;
    const redactSeeds = new Set(s.redactSeeds);
    const deliveries = new Map<string, NonNullable<TurnInput['onAccepted']>>();
    const pendingTools = new Set<string>();
    const transcriptPath = join(this.transcripts.projectDirFor(s.cwd), `${nativeId}.jsonl`);
    const checkTranscript = () => {
      if (seedToken && hasClaudeUserRecord(transcriptPath, { seed: seedToken })) {
        cb.onSeedAccepted?.(seedToken);
        seedToken = undefined;
      }
      for (const [id, accepted] of deliveries) {
        if (!hasClaudeUserRecord(transcriptPath, { uuid: id })) continue;
        accepted(id);
        deliveries.delete(id);
      }
    };
    let gating = 0;
    const scopedHost: RuntimeHost = {
      gateToolCall: async (req) => {
        if (s.canStartTool?.() === false) return { allow: false, reason: 'Runtime switch in progress' };
        gating++;
        try {
          const decision = await host.gateToolCall({ ...req, sessionId: logical(req.sessionId) });
          if (decision.allow && req.toolUseId) pendingTools.add(req.toolUseId);
          return decision;
        } finally { gating--; }
      },
      onToolFailed: (req) => { if (current()) host.onToolFailed({ ...req, sessionId: logical(req.sessionId) }); },
      onToolCompleted: (req) => { if (current()) host.onToolCompleted({ ...req, sessionId: logical(req.sessionId) }); },
      onTurnEnded: (id) => {
        if (s.canStartTool?.() === false) return;
        checkTranscript();
        host.onTurnEnded(logical(id));
      },
      onTurnFailed: (id, error, details) => {
        if (s.canStartTool?.() === false) return;
        checkTranscript();
        if (seedToken) cb.onSeedUncertain?.(seedToken);
        host.onTurnFailed(logical(id), error, details);
      },
      onUsage: (id, update) => { if (current()) host.onUsage(logical(id), update); },
    };
    const session = new ClaudeSdkSession({
      options: {
        cwd: s.cwd,
        env: {
          ...process.env,
          DAEMON_AUTH: this.opts.daemonAuthSecret,
          DAEMON_HOST: this.opts.daemonHost,
          OUTPOST_HOOK_PORT: String(this.opts.hookPort),
          ...s.env,
        },
        ...(s.mode === 'resume' ? { resume: nativeId } : { sessionId: nativeId }),
        ...(s.model ? { model: s.model } : {}),
        ...(s.permissionMode ? { permissionMode: s.permissionMode } : {}),
        includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code', ...(s.appendSystemPrompt ? { append: s.appendSystemPrompt } : {}) },
        settingSources: ['user', 'project', 'local'],
        mcpServers: (() => {
          const outpost = this.opts.mcpServers.outpost;
          return s.launchCredential && outpost?.type === 'http' ? {
            ...this.opts.mcpServers, outpost: { ...outpost, headers: { ...outpost.headers, 'X-Outpost-Launch': s.launchCredential } },
          } : this.opts.mcpServers;
        })(),
        hooks: claudeHooks(scopedHost, { isAction: s.isAction, approvalTimeoutMs: this.opts.approvalTimeoutMs }),
        // Outpost's gate is the only approval surface; nothing may fall through to a prompt.
        permissionPrompts: 'none',
        stderr: (d) => cb.onError(`[claude stderr] ${d}`),
        ...sdkExecutable(),
      },
      onMessage: (msg) => {
        if (!current()) return;
        if (msg.type === 'user' && msg.uuid) {
          deliveries.get(msg.uuid)?.(msg.uuid);
          deliveries.delete(msg.uuid);
        }
        if (redactSeeds.size && msg.type === 'user' && msg.message.role === 'user' && Array.isArray(msg.message.content)) {
          const content = msg.message.content.filter((block) => block.type !== 'text'
            || ![...redactSeeds].some((token) => isHandoffSeed(block.text, token)));
          if (content.length !== msg.message.content.length) {
            if (seedToken && msg.message.content.some((block) => block.type === 'text' && isHandoffSeed(block.text, seedToken))) {
              cb.onSeedAccepted?.(seedToken);
              seedToken = undefined;
            }
            msg = { ...msg, message: { ...msg.message, content } };
          }
        }
        s.log?.native(msg);
        for (const e of mapper.map(msg)) {
          cb.onEvent(e.type === 'session.started' ? { ...e, sessionId: logical(e.sessionId) } : e);
          if (e.type === 'item.completed' && e.item.type === 'tool_call') pendingTools.delete(e.item.id);
        }
        if (msg.type === 'assistant') checkTranscript();
        const statusline = usage.observe(msg);
        if (statusline && msg.session_id) scopedHost.onUsage(msg.session_id, { statusline });
      },
      onError: cb.onError,
      onExit: cb.onExit,
    });
    return {
      sendTurn: (turn, seed) => {
        if (seed) {
          seedToken = seed.token;
          redactSeeds.add(seed.token);
        }
        if (turn.deliveryId && turn.onAccepted) deliveries.set(turn.deliveryId, turn.onAccepted);
        session.send(toUserFrame(turn, nativeId, seed?.block));
      },
      hasPendingTools: () => gating > 0 || pendingTools.size > 0,
      interrupt: () => session.interrupt(),
      kill: () => session.kill(),
    };
  }

  deliverActions(actionsDir: string): void {
    deliverActionsAsSkills(actionsDir);
  }

  contextWindowHint(cwd: string): number | null {
    return readProjectContextWindow(cwd);
  }
}
