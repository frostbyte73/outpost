import type { EvalOutcome } from './eval-verdict.js';
import type { EvalRecord, UserVerdict } from './eval-store.js';

export interface EvalAgreementRow {
  id: string;
  action: string;
  startedAt: number;
  outcome?: EvalOutcome;
  userVerdict?: UserVerdict;
  agreed?: boolean;
  spentUsd: number;
  reasons: string[];
}

export interface EvalAgreement {
  total: number;
  byOutcome: Record<EvalOutcome, number>;
  reviewed: number;
  agreed: number;
  // A pass the user rejected — the error auto-apply would have shipped.
  falsePasses: number;
  // A fail/inconclusive the user approved — an improvement auto-apply would have dropped.
  falseFails: number;
  spentUsd: number;
  recent: EvalAgreementRow[];
}

const RECENT_ROWS = 20;

// How often the shadow eval's verdict matched the user's, which is what auto-apply is gated on.
export function evalAgreement(records: EvalRecord[]): EvalAgreement {
  const byOutcome: Record<EvalOutcome, number> = { pass: 0, fail: 0, inconclusive: 0 };
  let reviewed = 0, agreed = 0, falsePasses = 0, falseFails = 0, spentUsd = 0;
  for (const r of records) {
    spentUsd += r.spentUsd;
    if (!r.outcome) continue;
    byOutcome[r.outcome] += 1;
    if (!r.userVerdict) continue;
    reviewed += 1;
    if (r.agreed) agreed += 1;
    else if (r.outcome === 'pass') falsePasses += 1;
    else falseFails += 1;
  }
  const recent = [...records]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, RECENT_ROWS)
    .map((r) => ({
      id: r.id, action: r.action, startedAt: r.startedAt, outcome: r.outcome,
      userVerdict: r.userVerdict, agreed: r.agreed, spentUsd: r.spentUsd, reasons: r.reasons,
    }));
  return { total: records.length, byOutcome, reviewed, agreed, falsePasses, falseFails, spentUsd, recent };
}
