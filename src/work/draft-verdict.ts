import type { ActionRunOutcome } from '../storage/action-runs-store.js';
import { unifiedSkillDiff } from '../actions/skill-diff.js';
import type { PrFacts } from './work-types.js';
import type { PinnedCall } from './write-draft.js';

export interface DraftVerdictDetail {
  edit?: { chars: number; diff: string };
  feedbackText?: string;
  stale?: boolean;
}

// No CI state: it settles under nearly every reply draft and would discard the edits worth keeping.
export function factsFingerprint(pr: PrFacts | undefined): string {
  if (!pr) return '';
  return JSON.stringify([
    pr.headRefOid ?? null, pr.branchHeadOid ?? null, pr.mergeable ?? null, pr.reviewState ?? null,
    (pr.comments ?? []).map((c) => c.id).sort(),
  ]);
}

// The PWA re-serialises JSON bodies; sorted keys and raw string lines make a one-word edit one line.
export function renderValue(v: unknown, key = ''): string[] {
  if (typeof v === 'string') return key ? [`${key}:`, ...v.split('\n')] : v.split('\n');
  if (v && typeof v === 'object') {
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]] as const);
    return entries.flatMap(([k, x]) => renderValue(x, key ? `${key}.${k}` : k));
  }
  return [`${key}: ${JSON.stringify(v)}`];
}

function renderBody(body: string): string[] {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object') return renderValue(parsed);
  } catch { /* not JSON — the raw text is the payload */ }
  return body.split('\n');
}

export function renderDraftCalls(calls: Array<Pick<PinnedCall, 'bash' | 'tool' | 'files'> & { id?: string; label?: string }>): string {
  return calls.flatMap((c) => [
    `## ${c.label ?? c.id ?? 'call'}`,
    ...(c.bash ? [c.bash.replace(/\/tmp\/\S+/g, '<tmp>')] : []),
    ...(c.tool ? [`tool: ${c.tool.name}`, ...renderValue(c.tool.args)] : []),
    ...Object.values(c.files ?? {}).flatMap(renderBody),
  ])
    .flatMap((l) => l.split(/\r?\n/))
    .map((l) => l.replace(/\r$/, '').trimEnd())
    .join('\n')
    .trimEnd();
}

// The drafted-vs-approved difference, whitespace-insensitive; a skipped call is a removed block.
export function draftEdit(drafted: PinnedCall[], approved: PinnedCall[]): { chars: number; diff: string } | undefined {
  const before = renderDraftCalls(drafted);
  const after = renderDraftCalls(approved);
  if (before === after) return undefined;
  // Drop unifiedSkillDiff's SKILL.md headers; the hunks are what the improver reads.
  const diff = unifiedSkillDiff(before, after).split('\n').slice(3).join('\n');
  const chars = diff.split('\n')
    .filter((l) => l.startsWith('+') || l.startsWith('-'))
    .reduce((n, l) => n + l.length - 1, 0);
  return { chars, diff };
}

export function resolveVerdictOutcome(outcome: ActionRunOutcome, detail: DraftVerdictDetail | undefined): ActionRunOutcome {
  if (!detail || outcome === 'auto-accepted') return outcome;
  const edited = !!detail.edit && (outcome === 'accepted' || outcome === 'denied');
  if (detail.stale && (edited || outcome === 'denied' || outcome === 'revised')) return 'superseded';
  return edited ? 'edited' : outcome;
}
