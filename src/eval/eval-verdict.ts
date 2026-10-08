// A blind A/B result, already mapped back from A/B to which SKILL.md version won.
export type Comparison = 'after' | 'before' | 'tie';

export type EvalOutcome = 'pass' | 'fail' | 'inconclusive';

// Rounds whose output is code or prose with no draft to diff; a tie there means "no better".
export const ARTIFACT_ACTIONS: ReadonlySet<string> = new Set([
  'code.implement', 'code.fix-ci', 'code.fix-pr-comment', 'code.spec', 'code.plan', 'read.investigate',
]);

export const DEFAULT_EVAL_CAP_USD = 5;

const GROWTH_ALLOWANCE = 1.05;
const GROWTH_MIN_WINS = 3;
const TIE_TOLERANCE_MIN_TARGETS = 3;

export interface EvalVerdictInput {
  action: string;
  cutOnly: boolean;
  targets: Comparison[];
  regression: Comparison[];
  regressionAvailable: number;
  tokensBefore: number;
  tokensAfter: number;
  ceiling: number | null;
  spentUsd: number;
  capUsd: number;
}

export function evalVerdict(i: EvalVerdictInput): { outcome: EvalOutcome; reasons: string[] } {
  const fail: string[] = [];
  if (i.ceiling !== null && i.tokensAfter > i.ceiling) fail.push(`${i.tokensAfter} tokens is over the ${i.ceiling} ceiling`);
  const wins = i.targets.filter((t) => t === 'after').length;
  if (i.cutOnly) {
    if (i.tokensAfter >= i.tokensBefore) fail.push(`a cut must shrink the skill (${i.tokensBefore} → ${i.tokensAfter} tokens)`);
  } else {
    const limit = wins >= GROWTH_MIN_WINS ? i.tokensBefore * GROWTH_ALLOWANCE : i.tokensBefore;
    if (i.tokensAfter > limit) fail.push(`grew ${i.tokensBefore} → ${i.tokensAfter} tokens without ${GROWTH_MIN_WINS} target wins`);
    const losses = i.targets.filter((t) => t === 'before').length;
    const ties = i.targets.filter((t) => t === 'tie').length;
    const tiesAllowed = ARTIFACT_ACTIONS.has(i.action) || i.targets.length < TIE_TOLERANCE_MIN_TARGETS ? 0 : 1;
    if (losses > 0) fail.push(`lost ${losses} of ${i.targets.length} target run${i.targets.length === 1 ? '' : 's'}`);
    if (ties > tiesAllowed) fail.push(`tied ${ties} of ${i.targets.length} target runs`);
  }
  const regressionLosses = i.regression.filter((r) => r === 'before').length;
  if (regressionLosses > 0) fail.push(`lost ${regressionLosses} regression run${regressionLosses === 1 ? '' : 's'}`);
  if (fail.length > 0) return { outcome: 'fail', reasons: fail };

  // The eval's own cost says nothing about the proposal, so it never grades one down.
  const inconclusive: string[] = [];
  if (i.spentUsd > i.capUsd) inconclusive.push(`spend $${i.spentUsd.toFixed(2)} exceeded the $${i.capUsd} cap`);
  if (!i.cutOnly && i.targets.length < 1) inconclusive.push('no target run replayed validly');
  if (i.cutOnly && i.regression.length < 1) inconclusive.push('a cut is judged on regression runs and none replayed validly');
  if (i.regression.length < i.regressionAvailable - 1) {
    inconclusive.push(`only ${i.regression.length} of ${i.regressionAvailable} regression runs replayed validly`);
  }
  if (inconclusive.length > 0) return { outcome: 'inconclusive', reasons: inconclusive };
  return { outcome: 'pass', reasons: [`won ${wins} of ${i.targets.length} targets, no regression losses`] };
}
