import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parsePreapprovals } from '../work/preapprovals.js';
import { isReviewerEntry } from '../git/pr-reviewers.js';
import type { Preapprovals } from '../work/work-types.js';

export type PreferencesBlob = Record<string, unknown>;

export interface PrReviewIntake {
  repos: string[];
  reviewRequested: boolean;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Schema-light client-preferences store synced across devices. The daemon does
// not enumerate individual preferences — it stores an opaque JSON object and
// only guarantees it is a plain object. Per-key validation lives on the client.
export class PreferencesStore {
  private prefs: PreferencesBlob = {};

  constructor(private readonly path: string) {
    this.load();
  }

  get(): PreferencesBlob {
    return { ...this.prefs };
  }

  // Shallow-merges patch into the blob, persists, returns the merged result.
  merge(patch: PreferencesBlob): PreferencesBlob {
    this.prefs = { ...this.prefs, ...patch };
    this.persist();
    return this.get();
  }

  // Typed accessors for the preferences the daemon itself acts on (the token-launch
  // queue's concurrency; the editor the git view opens on this host) — everything else
  // stays opaque.
  getLaunchConcurrency(): number {
    const raw = (this.get() as { launchConcurrency?: unknown }).launchConcurrency;
    return Number.isInteger(raw) && (raw as number) >= 1 ? (raw as number) : 1;
  }

  // The user's pause on the job launch queue. Absent reads as running.
  getLaunchQueuePaused(): boolean {
    return (this.get() as { launchQueuePaused?: unknown }).launchQueuePaused === true;
  }

  // `!` in the composer runs whatever the user types with no allowlist and no approval card
  // (see session/shell-exec.ts), so it stays off until turned on in Settings > Permissions.
  // Absent reads as off — an older preferences.json must not grant it.
  getShellCommandsEnabled(): boolean {
    return (this.get() as { shellCommands?: unknown }).shellCommands === true;
  }

  // Undefined rather than a default, so the fallback lives with the code that spawns it.
  getEditorCommand(): string | undefined {
    const raw = (this.get() as { editorCommand?: unknown }).editorCommand;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
  }

  // Off unless opted into — which PRs get reviewed is entirely per-user
  getPrReviewIntake(): PrReviewIntake {
    const raw = (this.get() as { prReviewIntake?: unknown }).prReviewIntake;
    const o = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as { repos?: unknown; reviewRequested?: unknown }
      : {};
    const repos = Array.isArray(o.repos)
      ? [...new Set(o.repos
          .filter((r): r is string => typeof r === 'string' && REPO_RE.test(r.trim()))
          .map((r) => r.trim().toLowerCase()))]
      : [];
    return { repos, reviewRequested: o.reviewRequested === true };
  }

  getPrReviewers(): string[] {
    const raw = (this.get() as { prReviewers?: unknown }).prReviewers;
    return Array.isArray(raw) ? raw.filter(isReviewerEntry) : [];
  }

  // A passing improver eval rewrites SKILL.md with nobody looking, so absent reads as off.
  getImproverAutoApply(): boolean {
    return (this.get() as { improverAutoApply?: unknown }).improverAutoApply === true;
  }

  // Pulling main restarts the daemon with nobody looking, so absent reads as off.
  getAutoUpdate(): boolean {
    return (this.get() as { autoUpdate?: unknown }).autoUpdate === true;
  }

  // Settings-level pre-approvals under every job's own. Anything unparseable reads as gated.
  getPreapprovalDefaults(): Preapprovals | undefined {
    const parsed = parsePreapprovals((this.get() as { preapprovalDefaults?: unknown }).preapprovalDefaults);
    return parsed.ok ? parsed.value : undefined;
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.prefs = parsed as PreferencesBlob;
      }
    } catch {
      // Malformed → treat as empty; overwritten on next merge().
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.prefs, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
