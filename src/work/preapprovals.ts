import { isPlainObject } from '../routes/util.js';
import type { Landing, Preapprovals, SpecMode } from './work-types.js';

export interface EffectivePreapprovals {
  spec: SpecMode;
  push: boolean;
  openPr: boolean;
  replies: boolean;
  merge: boolean;
  syncBase: boolean;
  landing: Landing;
}

export const GATED_PREAPPROVALS: EffectivePreapprovals = {
  spec: 'gate', push: false, openPr: false, replies: false, merge: false, syncBase: false, landing: 'merged',
};

const SPEC_ORDER: readonly SpecMode[] = ['gate', 'auto', 'skip'];
const LANDING_ORDER: readonly Landing[] = ['merged', 'approved', 'direct'];
const BOOL_KEYS = ['push', 'openPr', 'replies', 'merge', 'syncBase'] as const;
const KEYS: ReadonlyArray<keyof Preapprovals> = ['spec', ...BOOL_KEYS, 'landing'];

function defined(p: Preapprovals | undefined): Preapprovals {
  const out: Record<string, unknown> = {};
  for (const k of KEYS) if (p?.[k] !== undefined) out[k] = p[k];
  return out as Preapprovals;
}

// `globalPre` is the user's Settings default; anything the job or step sets wins over it.
export function effectivePreapprovals(globalPre?: Preapprovals, jobPre?: Preapprovals, stepPre?: Preapprovals): EffectivePreapprovals {
  return { ...GATED_PREAPPROVALS, ...defined(globalPre), ...defined(jobPre), ...defined(stepPre) };
}

export function anyPreapproved(e: EffectivePreapprovals): boolean {
  return KEYS.some((k) => e[k] !== GATED_PREAPPROVALS[k]);
}

function stricter<T>(order: readonly T[], a: T, b: T): T {
  return order[Math.min(order.indexOf(a), order.indexOf(b))]!;
}

export function clampToCeiling(proposed: Preapprovals, ceiling: EffectivePreapprovals): Preapprovals {
  const out: Preapprovals = {};
  if (proposed.spec !== undefined) out.spec = stricter(SPEC_ORDER, proposed.spec, ceiling.spec);
  for (const k of BOOL_KEYS) if (proposed[k] !== undefined) out[k] = proposed[k]! && ceiling[k];
  if (proposed.landing !== undefined) out.landing = stricter(LANDING_ORDER, proposed.landing, ceiling.landing);
  return out;
}

export function loosenedFields(proposed: Preapprovals, ceiling: EffectivePreapprovals): Array<keyof Preapprovals> {
  const clamped = clampToCeiling(proposed, ceiling);
  return KEYS.filter((k) => proposed[k] !== undefined && proposed[k] !== clamped[k]);
}

export function describePreapprovals(p: Preapprovals | undefined): string {
  const set = defined(p);
  return Object.keys(set).length ? JSON.stringify(set) : 'none (inherits the job)';
}

export function parsePreapprovals(raw: unknown): { ok: true; value: Preapprovals | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!isPlainObject(raw)) return { ok: false, error: 'preapprovals must be an object' };
  const out: Preapprovals = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (k === 'spec') {
      if (!SPEC_ORDER.includes(v as SpecMode)) return { ok: false, error: `preapprovals.spec must be one of ${SPEC_ORDER.join('|')}` };
      out.spec = v as SpecMode;
    } else if (k === 'landing') {
      if (!LANDING_ORDER.includes(v as Landing)) return { ok: false, error: `preapprovals.landing must be one of ${LANDING_ORDER.join('|')}` };
      out.landing = v as Landing;
    } else if ((BOOL_KEYS as readonly string[]).includes(k)) {
      if (typeof v !== 'boolean') return { ok: false, error: `preapprovals.${k} must be a boolean` };
      out[k as typeof BOOL_KEYS[number]] = v;
    } else {
      return { ok: false, error: `unknown preapprovals field ${JSON.stringify(k)}` };
    }
  }
  return { ok: true, value: out };
}

export function sessionGrantRefusal(args: Record<string, unknown>): string | undefined {
  if (args.preapprovals === undefined && args.planReview === undefined) return undefined;
  return 'a session cannot set preapprovals or planReview — only the user can, in the PWA';
}

export function parsePlanReview(raw: unknown): { ok: true; value: 'gate' | 'auto' | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (raw === 'gate' || raw === 'auto') return { ok: true, value: raw };
  return { ok: false, error: 'planReview must be gate|auto' };
}
