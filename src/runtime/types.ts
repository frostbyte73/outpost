import type { NdjsonLog } from './event-ndjson.js';

export type ToolKind =
  | 'command_execution'
  | 'file_read'
  | 'file_change'
  | 'mcp_tool_call'
  | 'web_fetch'
  | 'web_search'
  | 'collab_agent_tool_call'
  | 'dynamic_tool_call';

export type ItemStatus = 'inProgress' | 'completed' | 'failed' | 'declined';

export interface ToolCallItem {
  type: 'tool_call';
  id: string;
  messageId?: string;
  kind: ToolKind;
  tool: string;
  // The runtime's own name for the tool — what the UI shows and what persisted rules spell.
  rawName: string;
  input: unknown;
  status: ItemStatus;
  resultText?: string;
  declineReason?: string;
}

// One unit of session history; transcripts and live `item.*` events carry the same shape.
export type CanonicalItem =
  | { type: 'user_message'; id: string; text: string; images?: number }
  | { type: 'assistant_message'; id: string; messageId?: string; text: string }
  | ToolCallItem
  | { type: 'user_shell'; id: string; command: string; stdout: string; stderr: string };

// A runtime's own periodic usage report (Claude: the statusLine payload, field names camelCased).
export interface StatuslineUsage {
  model?: { id?: string; display_name?: string };
  contextWindow?: unknown;
  cost?: {
    total_cost_usd?: number;
    total_duration_ms?: number;
    total_api_duration_ms?: number;
    total_lines_added?: number;
    total_lines_removed?: number;
  };
  rateLimits?: unknown;
  effort?: unknown;
  exceeds200k?: boolean;
}

export interface UsageUpdate {
  model?: string;
  // Tokens of one completed model response.
  response?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
  streamingOutputTokens?: number;
  // Keyed by the model id the runtime reported, which may carry a variant suffix.
  contextWindows?: Record<string, number>;
  statusline?: StatuslineUsage;
}

export interface SubagentRef {
  agentId?: string;
  parentToolCallId?: string;
}

// What a runtime emits for a session, after mapping its native stream.
export type CanonicalEvent = { subagent?: SubagentRef } & (
  | { type: 'session.started'; sessionId: string; model?: string; mcpServers: { name: string; status: string }[] }
  | { type: 'turn.started' }
  | { type: 'item.started'; item: CanonicalItem }
  | { type: 'item.completed'; item: CanonicalItem }
  | { type: 'content.delta'; stream: 'assistant_text' | 'reasoning' | 'tool_input'; text: string }
  | { type: 'usage.updated'; usage: UsageUpdate }
  | { type: 'turn.completed'; state: 'completed' | 'failed' | 'interrupted' | 'cancelled'; stopReason?: string }
  | { type: 'task.notification'; taskId: string; status?: string; summary?: string }
);

export interface TurnInput {
  text: string;
  images?: { mediaType: string; data: string }[];
}

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
export type SessionModel = 'sonnet' | 'opus' | 'haiku' | 'fable';

export interface StartOpts {
  sessionId: string;
  mode: 'new' | 'resume';
  cwd: string;
  env: Record<string, string>;
  model?: SessionModel;
  appendSystemPrompt?: string;
  permissionMode?: PermissionMode;
  // Action sessions get the settings variant that records reads for eval replay.
  isAction: boolean;
  log?: NdjsonLog;
}

export interface StartCallbacks {
  onEvent: (e: CanonicalEvent) => void;
  onError: (msg: string) => void;
  onExit: (code: number | null) => void;
}

export interface RuntimeSession {
  sendTurn(turn: TurnInput): void;
  interrupt(): void;
  kill(): Promise<void>;
}

export interface GateRequest {
  sessionId: string;
  toolUseId?: string;
  tool: string;
  rawName: string;
  input: unknown;
  subagent?: { agentId: string; agentType?: string };
}

export type GateDecision = { allow: true } | { allow: false; reason?: string };

// The daemon's side of a runtime: every policy decision and lifecycle signal a runtime reports.
export interface RuntimeHost {
  gateToolCall(req: GateRequest): Promise<GateDecision>;
  onToolFailed(r: { sessionId: string; toolUseId?: string; tool: string; input: unknown; interrupted: boolean }): void;
  onToolCompleted(r: { sessionId: string; tool: string; rawName: string; input: unknown; response: unknown }): void;
  onTurnEnded(sessionId: string): void;
  onTurnFailed(sessionId: string, error: string, details?: string): void;
  onUsage(sessionId: string, usage: UsageUpdate): void;
}

export interface RuntimeCapabilities {
  sessions: { supportsResume: boolean };
  streaming: { streamsAssistantText: boolean };
  tools: { supportsMcpTools: boolean };
  approvals: {
    supportsCommandApproval: boolean;
    supportsFileChangeApproval: boolean;
    approvalsCanOriginateFromSubagents: boolean;
    approvalCallbacksAreLiveOnly: boolean;
  };
  // `native`: the runtime enforces policy itself; `client-boundary`: Outpost intercepts each call.
  runtimePolicy: { enforcement: 'native' | 'client-boundary' };
}

export type SessionKind = 'normal' | 'action-edit' | 'skill-edit' | 'schedule-edit';

export interface SessionInfo {
  id: string;
  title: string;
  lastModified: number;
  // Newest prompt dc typed, else the session file's creation.
  lastEngagedAt?: number;
  lastReplyAt?: number;
  path: string;
  worktreePath?: string;
  worktreeBranch?: string;
  archived?: boolean;
  // Set when this session was spawned for action / skill authoring; lets the
  // Projects view filter them out. Tracked in-memory on SessionManager; lost on
  // daemon restart (acceptable — these are short-lived sessions).
  kind?: SessionKind;
  // Set from the durable session-meta sidecar for any session Outpost spawned to
  // run an action on the user's behalf (orchestrator, step, or action/skill edit).
  // 'action' vs a plain interactive 'session' drives the sessions-list tabs + badge.
  sessionClass?: 'action' | 'session';
  // The action a `sessionClass: 'action'` session runs (e.g. `meta.orchestrate`,
  // `code.implement`, `meta.build-action`), surfaced as the list card's badge.
  actionLabel?: string;
  // Live proc state, annotated by GET /api/sessions from SessionManager.
  runState?: 'foreground' | 'background' | 'idle';
  working?: boolean;
  seenAt?: number;
}

export interface ProjectInfo {
  projectDir: string;
  cwd: string;
  lastModified: number;
  sessions: SessionInfo[];
  isGitRepo: boolean;
  source: 'claude' | 'registry' | 'both';
  // Populated only when the user has run a `[1m]` model variant; lets the PWA pick 1M over the 200k default.
  contextWindowSize?: number;
  // A cwd the daemon itself created under the runtime dir — an installed action dir or a step
  // worktree. Still in the payload because session lookups resolve through the project row, but
  // never offered as a place to start new work.
  internal?: boolean;
}

export interface SubagentCompletion {
  status: string;
  summary?: string;
  result?: string;
  completedAt: number;
}

export interface SubagentInfo {
  agentId: string;
  agentType: string;
  description?: string;
  parentToolUseId?: string;
  firstSeenAt: number;
  entries: CanonicalItem[];
  completion: SubagentCompletion | null;
}

export interface SessionLocation {
  projectDir: string;
  cwd: string;
  session: SessionInfo;
}

export interface TranscriptProject {
  projectDir: string;
  cwd: string;
  lastModified: number;
  sessions: SessionInfo[];
}

// Reads a runtime's own on-disk session history.
export interface TranscriptReader {
  // One entry per physical history dir whose cwd still exists or is a known worktree.
  scanProjectDirs(knownWorktreePaths: ReadonlySet<string>): TranscriptProject[];
  // Where the runtime would keep history for a cwd it has none for yet.
  projectDirFor(cwd: string): string;
  // `projectDir` is one scanProjectDirs returned; `id` is already checked to be a bare id.
  readItems(projectDir: string, id: string): CanonicalItem[];
  readSubagents(projectDir: string, id: string): SubagentInfo[];
  deleteTranscript(projectDir: string, id: string): boolean;
}

// One agent harness behind Outpost's sessions.
export interface AgentRuntime {
  readonly id: string;
  readonly capabilities: RuntimeCapabilities;
  start(opts: StartOpts, cb: StartCallbacks): RuntimeSession;
  readonly transcripts: TranscriptReader;
  deliverActions(actionsDir: string): void;
  contextWindowHint(cwd: string): number | null;
}
