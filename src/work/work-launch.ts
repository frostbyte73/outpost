import type { JobRecord } from './work-types.js';

export interface LaunchTarget { stepId?: string; dispatchId?: string; allowManualSession?: boolean }

// A meta.session's manualSession has no allowlist, so only tools built for it pass `allowManualSession`.
export function resolveWorkSession(job: JobRecord | undefined, t: LaunchTarget): string | undefined {
  const step = t.stepId ? job?.steps.find((s) => s.id === t.stepId) : undefined;
  if (t.dispatchId) {
    return step?.type === 'orchestrated' ? step.dispatches.find((d) => d.id === t.dispatchId)?.sessionId : undefined;
  }
  if (!t.stepId) return job?.orchestratorSessionId;
  if (t.allowManualSession && step?.type === 'action' && step.action === 'meta.session') return step.manualSession?.id;
  return step?.sessionId
    ?? job?.steps.flatMap((s) => (s.type === 'orchestrated' ? s.dispatches : [])).find((d) => d.id === t.stepId)?.sessionId;
}

export type SessionReport = {
  summary: string;
  report: string;
  answers?: { question: string; answer: string }[];
  corrections?: string[];
  wantsReplan?: boolean;
};

export function parseSessionReport(a: Record<string, unknown>): SessionReport | string {
  const nonEmpty = (v: unknown) => typeof v === 'string' && v.trim() !== '';
  if (!nonEmpty(a.summary)) return 'summary must be a non-empty string';
  if (!nonEmpty(a.report)) return 'report must be a non-empty string';
  const { answers, corrections, wantsReplan } = a;
  if (answers !== undefined && !(Array.isArray(answers) && answers.every((x) =>
    x && typeof x === 'object' && typeof x.question === 'string' && typeof x.answer === 'string'))) {
    return 'answers must be an array of {question, answer} strings';
  }
  if (corrections !== undefined && !(Array.isArray(corrections) && corrections.every((x) => typeof x === 'string'))) {
    return 'corrections must be an array of strings';
  }
  if (wantsReplan !== undefined && typeof wantsReplan !== 'boolean') return 'wantsReplan must be a boolean';
  return {
    summary: a.summary as string,
    report: a.report as string,
    ...(answers ? { answers: (answers as { question: string; answer: string }[]).map(({ question, answer }) => ({ question, answer })) } : {}),
    ...(corrections ? { corrections: corrections as string[] } : {}),
    ...(wantsReplan !== undefined ? { wantsReplan } : {}),
  };
}

export type ReplanRequestInput = { reason: string; evidence?: string; suggestion?: string };

// Keyed on `stepId` naming a real step, not on a `dispatchId` argument: resolveWorkSession maps a
// dispatch id passed as `stepId` to the child's own session, so the argument alone proves nothing.
export function parseReplanRequest(job: JobRecord | undefined, a: Record<string, unknown>): ReplanRequestInput | string {
  const step = job?.steps.find((s) => s.id === a.stepId);
  if (a.dispatchId !== undefined || !step) {
    return "a dispatched child cannot ask for a replan — whether this step needs one is its controller's call. Report the finding in your output";
  }
  if (step.type === 'orchestrated') return 'a controller asks with submit_step_progress next: {kind: "replan"}';
  const { reason, evidence, suggestion } = a;
  if (typeof reason !== 'string' || !reason.trim()) return 'reason must be a non-empty string';
  if (evidence !== undefined && typeof evidence !== 'string') return 'evidence must be a string';
  if (suggestion !== undefined && typeof suggestion !== 'string') return 'suggestion must be a string';
  return {
    reason,
    ...(evidence ? { evidence: evidence as string } : {}),
    ...(suggestion ? { suggestion: suggestion as string } : {}),
  };
}
