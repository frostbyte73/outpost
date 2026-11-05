import type { McpServerConfig, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSdkSession } from './sdk-session.js';
import { StreamJsonMapper } from './events.js';
import { StatuslineSynth } from './usage.js';
import { claudeHooks } from './hooks.js';
import { sdkExecutable } from './bin.js';
import { deliverActionsAsSkills } from './skills.js';
import { readProjectContextWindow } from './config.js';
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
export function toUserFrame(turn: TurnInput, sessionId: string): SDKUserMessage {
  const images = turn.images ?? [];
  const content = images.length === 0 ? turn.text : [
    ...images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType as 'image/png', data: i.data } })),
    // The API rejects an empty text block, so a photo sent on its own carries none.
    ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
  ];
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: sessionId } as SDKUserMessage;
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
        ...(s.mode === 'resume' ? { resume: s.sessionId } : { sessionId: s.sessionId }),
        ...(s.model ? { model: s.model } : {}),
        ...(s.permissionMode ? { permissionMode: s.permissionMode } : {}),
        includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code', ...(s.appendSystemPrompt ? { append: s.appendSystemPrompt } : {}) },
        settingSources: ['user', 'project', 'local'],
        mcpServers: this.opts.mcpServers,
        hooks: claudeHooks(host, { isAction: s.isAction, approvalTimeoutMs: this.opts.approvalTimeoutMs }),
        // Outpost's gate is the only approval surface; nothing may fall through to a prompt.
        permissionPrompts: 'none',
        stderr: (d) => cb.onError(`[claude stderr] ${d}`),
        ...sdkExecutable(),
      },
      onMessage: (msg) => {
        s.log?.native(msg);
        for (const e of mapper.map(msg)) cb.onEvent(e);
        const statusline = usage.observe(msg);
        if (statusline && msg.session_id) host.onUsage(msg.session_id, { statusline });
      },
      onError: cb.onError,
      onExit: cb.onExit,
    });
    return {
      sendTurn: (turn) => session.send(toUserFrame(turn, s.sessionId)),
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
