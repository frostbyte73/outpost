// What pre-fills the commit box in the diff overlay, and what ⌘R cycles through.
// Pure: callers pass the resolved {job, step} context in, nothing here reads a store or the DOM.
//
// `step.title` and `step.goal` are fixed when the plan is posted, and `output` doesn't exist on an
// orchestrated step at all — so those three alone draft an identical message on round 1 and round
// 44 of the same PR. That's why the round that actually wrote the diff puts a commit-shaped
// summary in `artifacts.commitMessage`, and why it leads the list here. The daemon deletes that
// key on commit (WorkEngine.consumeCommitMessageDraft), so it only ever describes the diff
// currently sitting in the working tree.

function firstLine(s) {
  return (s ?? '').split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
}

// Best first. Deduped because with no `verdict` (always the case for an orchestrated step) the
// first and last templates collapse to the same string, and ⌘R landing on the text already in
// the box reads as a broken key.
export function commitMessageCandidates(ctx) {
  const step = ctx?.step;
  if (!step) return [];
  const title = step.title || 'Update';
  const verdict = (step.type === 'action' ? step.output : undefined)?.trim() || '';
  const goal = firstLine(step.goal);
  const out = [];
  for (const body of [
    (step.artifacts?.commitMessage ?? '').trim(),
    [title, verdict || goal].filter(Boolean).join('\n\n'),
    [`Fix: ${title}`, verdict || goal].filter(Boolean).join('\n\n'),
    [title, goal, verdict].filter(Boolean).join('\n\n'),
  ]) {
    // No `Closes <ticket>` trailer: a step is usually one of several on the same ticket, so
    // the commit that happens to be in the box is rarely the one that closes it.
    const msg = body.trim();
    if (msg && !out.includes(msg)) out.push(msg);
  }
  return out;
}

export function draftCommitMessage(ctx, variant) {
  const candidates = commitMessageCandidates(ctx);
  if (candidates.length === 0) return '';
  return candidates[((variant % candidates.length) + candidates.length) % candidates.length];
}
