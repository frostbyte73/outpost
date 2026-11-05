export interface HookTrust {
  key: string;
  hash: string;
}

export interface HookMetadata {
  key: string;
  eventName: string;
  handlerType: string;
  command?: string;
  timeoutSec: number;
  enabled: boolean;
  trustStatus: 'managed' | 'untrusted' | 'trusted' | 'modified';
  currentHash: string;
}

export interface HooksListResponse {
  data: { hooks: HookMetadata[]; errors: { path: string; message: string }[] }[];
}

export interface ExperimentalFeatureListResponse {
  data: { name: string; enabled: boolean }[];
  nextCursor: string | null;
}

export type TrustVerdict = 'trusted' | 'needs-trust' | { refuse: string };

export function findOutpostHook(list: HooksListResponse, command: string): HookMetadata | undefined {
  return list.data.flatMap((e) => e.hooks).find((h) => h.eventName === 'preToolUse' && h.command === command);
}

// Codex installs a hook only when it is enabled and trusted, so that, as Codex reports it, is the bar.
export function trustVerdict(h: HookMetadata | undefined, expectTimeoutSec: number): TrustVerdict {
  if (!h) return { refuse: "Codex did not load Outpost's PreToolUse hook" };
  if (!h.enabled) return { refuse: "Codex reports Outpost's PreToolUse hook as disabled" };
  if (h.timeoutSec !== expectTimeoutSec) {
    return { refuse: `Codex set Outpost's PreToolUse hook timeout to ${h.timeoutSec}s, not ${expectTimeoutSec}s` };
  }
  if (h.trustStatus === 'trusted' || h.trustStatus === 'managed') return 'trusted';
  if (h.trustStatus === 'untrusted') return 'needs-trust';
  return { refuse: `Codex reports Outpost's PreToolUse hook as ${h.trustStatus}` };
}

// The required-off features that Codex does not report as disabled for this thread.
export function featuresStillOn(list: ExperimentalFeatureListResponse['data'], required: readonly string[]): string[] {
  return required.filter((name) => list.find((f) => f.name === name)?.enabled !== false);
}
