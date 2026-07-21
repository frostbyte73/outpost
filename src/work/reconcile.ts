import type { ProposedStep, Step } from './work-types.js';

export interface Reconciliation {
  kept: Array<{ stepId: string; patch: Record<string, unknown> }>;
  added: ProposedStep[];
  cancelled: string[];
}

const MUTABLE_FIELDS = ['title', 'description', 'goal', 'approach', 'risks', 'parallelGroup', 'action', 'forwardOutput', 'inputs'] as const;

function buildPatch(current: Step, proposed: ProposedStep): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const cur = current as unknown as Record<string, unknown>;
  const pro = proposed as unknown as Record<string, unknown>;
  for (const f of MUTABLE_FIELDS) {
    const next = pro[f];
    const prev = cur[f];
    if (next !== undefined && next !== prev) patch[f] = next;
  }
  return patch;
}

export type DispositionCheck =
  | { ok: true }
  | { ok: false; error: string };

// Every non-cancelled step in `current` must appear exactly once: either as a
// `keepId` on some proposed step or as an entry in `drops`. Overlap, unknown
// ids, and missing dispositions are all rejected — implicit cancellation is
// gone, so an omission is a bug the orchestrator should hear about.
export function validateDispositions(current: Step[], proposed: ProposedStep[], drops: string[]): DispositionCheck {
  const currentIds = new Set(current.map((s) => s.id));

  const keepIds = new Set<string>();
  for (const p of proposed) {
    if (!p.keepId) continue;
    if (!currentIds.has(p.keepId)) {
      return { ok: false, error: `keepId "${p.keepId}" does not match any step in currentSteps` };
    }
    if (keepIds.has(p.keepId)) {
      return { ok: false, error: `keepId "${p.keepId}" is referenced by more than one proposed step` };
    }
    keepIds.add(p.keepId);
  }

  const dropSet = new Set<string>();
  for (const id of drops) {
    if (!currentIds.has(id)) {
      return { ok: false, error: `drop id "${id}" does not match any step in currentSteps` };
    }
    if (dropSet.has(id)) {
      return { ok: false, error: `drop id "${id}" listed more than once` };
    }
    dropSet.add(id);
  }

  const overlap = [...keepIds].filter((id) => dropSet.has(id));
  if (overlap.length > 0) {
    return { ok: false, error: `step id(s) both kept and dropped: ${overlap.join(', ')}` };
  }

  const missing = current
    .filter((s) => !s.cancelled && !keepIds.has(s.id) && !dropSet.has(s.id))
    .map((s) => `${s.id} ("${s.title}")`);
  if (missing.length > 0) {
    return { ok: false, error: `every non-cancelled step in currentSteps needs a disposition (keepId or drops). Missing: ${missing.join('; ')}` };
  }

  return { ok: true };
}

export function reconcile(current: Step[], proposed: ProposedStep[], drops: string[]): Reconciliation {
  const byId = new Map(current.map((s) => [s.id, s]));
  const kept: Reconciliation['kept'] = [];
  const added: ProposedStep[] = [];

  for (const p of proposed) {
    const match = p.keepId ? byId.get(p.keepId) : undefined;
    if (match) {
      kept.push({ stepId: match.id, patch: buildPatch(match, p) });
    } else {
      added.push(p);
    }
  }

  return { kept, added, cancelled: [...drops] };
}
