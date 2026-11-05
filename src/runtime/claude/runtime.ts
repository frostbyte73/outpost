import { ClaudeProc } from './proc.js';
import { StreamJsonMapper } from './events.js';
import { deliverActionsAsSkills } from './skills.js';
import { readProjectContextWindow } from './config.js';
import type {
  AgentRuntime, RuntimeCapabilities, RuntimeSession, StartCallbacks, StartOpts, TranscriptReader, TurnInput,
} from '../types.js';

export interface ClaudeRuntimeOpts {
  settingsPath: string;
  // Used instead of settingsPath for an action session.
  actionSettingsPath?: string;
  mcpConfigPath: string;
  daemonAuthSecret: string;
  daemonHost: string;
  hookPort: number;
  transcripts: TranscriptReader;
}

const CAPABILITIES: RuntimeCapabilities = {
  sessions: { supportsResume: true },
  streaming: { streamsAssistantText: true },
  tools: { supportsMcpTools: true },
  approvals: {
    supportsCommandApproval: true,
    supportsFileChangeApproval: true,
    approvalsCanOriginateFromSubagents: true,
    approvalCallbacksAreLiveOnly: true,
  },
  runtimePolicy: { enforcement: 'client-boundary' },
};

// Claude Code's `--input-format=stream-json` user message for one turn.
export function toUserFrame(turn: TurnInput): unknown {
  const images = turn.images ?? [];
  const content = images.length === 0 ? turn.text : [
    ...images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType, data: i.data } })),
    // The API rejects an empty text block, so a photo sent on its own carries none.
    ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
  ];
  return { type: 'user', message: { role: 'user', content } };
}

// The Claude Code CLI behind Outpost's sessions: stream-json over stdio, gated by loopback hooks.
export class ClaudeRuntime implements AgentRuntime {
  readonly id = 'claude';
  readonly capabilities = CAPABILITIES;
  readonly transcripts: TranscriptReader;

  constructor(private readonly opts: ClaudeRuntimeOpts) {
    this.transcripts = opts.transcripts;
  }

  start(s: StartOpts, cb: StartCallbacks): RuntimeSession {
    const mapper = new StreamJsonMapper();
    const proc = new ClaudeProc({
      sessionId: s.sessionId,
      mode: s.mode,
      settingsPath: s.isAction && this.opts.actionSettingsPath ? this.opts.actionSettingsPath : this.opts.settingsPath,
      mcpConfigPath: this.opts.mcpConfigPath,
      cwd: s.cwd,
      env: {
        DAEMON_AUTH: this.opts.daemonAuthSecret,
        DAEMON_HOST: this.opts.daemonHost,
        OUTPOST_HOOK_PORT: String(this.opts.hookPort),
        ...s.env,
      },
      ...(s.permissionMode ? { permissionMode: s.permissionMode } : {}),
      ...(s.model ? { model: s.model } : {}),
      ...(s.appendSystemPrompt ? { appendSystemPrompt: s.appendSystemPrompt } : {}),
      onMessage: (msg) => {
        s.log?.native(msg);
        for (const e of mapper.map(msg)) cb.onEvent(e);
      },
      onError: cb.onError,
      onExit: cb.onExit,
    });
    return {
      sendTurn: (turn) => proc.send(toUserFrame(turn)),
      interrupt: () => proc.interrupt(),
      kill: () => proc.kill(),
    };
  }

  deliverActions(actionsDir: string): void {
    deliverActionsAsSkills(actionsDir);
  }

  contextWindowHint(cwd: string): number | null {
    return readProjectContextWindow(cwd);
  }
}
