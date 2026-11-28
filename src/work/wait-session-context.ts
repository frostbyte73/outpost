import type { JobRecord, Step } from './work-types.js';

const OUTPUT_CAP = 2000;

// System prompt for the user-driven session on a meta.session step: what the job is, what the
// step is for, and what the steps before it produced.
export function waitSessionContext(job: JobRecord, stepId: string): string {
  const idx = job.steps.findIndex((s) => s.id === stepId);
  const step = job.steps[idx];
  if (!step || step.type !== 'action') throw new Error(`step ${stepId} is not an action step of job ${job.id}`);

  const lines = [
    'You are in a session Outpost started for the user as one step of a job; this session IS the step\'s work. The user drives it.',
    '',
    `# Job: ${job.title}`,
  ];
  if (job.description.trim()) lines.push('', job.description.trim());

  lines.push('', `# Step: ${step.title}`);
  const reason = step.inputs?.reason;
  if (typeof reason === 'string' && reason.trim()) lines.push('', reason.trim());

  const earlier = job.steps.slice(0, idx).filter((s) => !s.cancelled);
  if (earlier.length) {
    lines.push('', '# Earlier steps');
    for (const s of earlier) lines.push('', ...earlierStep(s));
  }

  lines.push('', ...reportingBack(job.id, stepId));
  return lines.join('\n');
}

function reportingBack(jobId: string, stepId: string): string[] {
  return [
    '# Reporting back',
    '',
    `This is job \`${jobId}\`, step \`${stepId}\`. When the user says they're done, or asks you to report back, call \`mcp__outpost__submit_session_report\` with that jobId and stepId:`,
    '- summary — one line',
    '- report — markdown: what was checked, what was found, what the user decided',
    '- answers — [{question, answer}] when the step asked clarification questions, the user\'s answers verbatim',
    '- corrections — the changes the user asked for, when this is a sign-off',
    '- wantsReplan — true when the user decided the plan should change',
    '',
    'Submitting resolves the step and the planner reviews it. Don\'t submit on your own judgment that the task looks finished. The user can also mark the step Done in the Outpost PWA instead.',
    '',
    '# Asking for a replan',
    '',
    'If you and the user find that the plan itself is wrong and this step\'s work can\'t go ahead (a false premise, a missing prerequisite step), call `mcp__outpost__submit_replan_request` with the same jobId and stepId instead of reporting. Pass `reason`, plus `evidence` and `suggestion` when you have them. The step doesn\'t resolve: the planner runs now and the user approves its amendment. Never use it because the task is hard. See `~/.outpost/actions/SHARED-replan-requests.md`.',
  ];
}

function earlierStep(s: Step): string[] {
  const out = [`## ${s.title} (${s.failure ? 'failed' : s.state})`];
  if (s.goal.trim()) out.push(`Goal: ${s.goal.trim()}`);
  if (s.type === 'orchestrated' && s.pr?.prUrl) out.push(`PR: ${s.pr.prUrl}${s.pr.prState ? ` (${s.pr.prState})` : ''}`);
  if (s.failure) out.push(`Failure: ${s.failure.reason}`);
  if (s.type === 'action' && s.output?.trim()) {
    const text = s.output.trim();
    out.push('Output:', text.length > OUTPUT_CAP ? `${text.slice(0, OUTPUT_CAP)}… [truncated]` : text);
  }
  return out;
}
