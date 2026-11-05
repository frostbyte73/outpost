import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaudeOnce, type RunClaudeOnce } from '../runtime/claude/once.js';
import type { JobRecord } from '../work/work-types.js';
import type { PrDraftGitContext } from './git-ops.js';

// Drafts a PR title and description for a branch several rounds committed to. The diff overlay's
// squash-and-open-PR otherwise publishes the commit box's text via `gh pr create --fill`, and that
// text is the LAST round's — so a PR squashing four rounds described one of them.
//
// One-shot and isolated on purpose: no tools (everything it needs is in the prompt), no setting sources
// (so none of the user's hooks or plugins run), no MCP servers, no slash commands, no saved
// session, and an empty cwd so no CLAUDE.md is discovered.

const SYSTEM_PROMPT = `You write the title and description of a pull request.
The branch was built in several rounds, and each round committed part of the work. The pull request squashes all of them, so describe the whole branch, not the last round.

Title: imperative mood, under 72 characters, about the whole change.

Description, in this order:
1. Problem. One paragraph: what goes wrong in the code before this branch, stated as behavior. The reader does not know the subsystem.
2. Change. One paragraph: what the new code does. Name any configuration flag and its default.
3. Failure case. A short paragraph of its own, only when the change handles a specific bad case: name it, what happened before, how the change handles it.
4. "## Impact" heading, only when the input contains measured evidence (numbers, test results, logs). Never invent a number, a percentage or a cause. Without evidence, leave the section out.
5. One closing sentence on rollout posture, for example that a flag defaults to off.
For a small change, one or two sentences and no headings are enough.

Writing rules:
- Lead each paragraph with its point.
- Short declarative sentences, one idea each. Active voice, plain words.
- No em-dashes: name the relation ("because", "but") or write two sentences.
- In the change paragraph state the behavior, not the history: no "now", "previously", "as before".
- No filler and no marketing: no "simply", "robust", "seamlessly", no bold for emphasis, no emoji.
- Use only facts from the input. Do not mention rounds, steps, squashing, or the tool that built the branch.`;

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', maxLength: 120 },
    body: { type: 'string' },
  },
  required: ['title', 'body'],
  additionalProperties: false,
};

const TIMEOUT_MS = 180_000;
const MAX_DESCRIPTION = 3000;

export interface PrDraft { title: string; body: string }

// The drafter's whole input, as its plain-text prompt. Exported for the test that pins it covers
// every round, not just the last.
export function prDraftInput(job: JobRecord | undefined, git: PrDraftGitContext): string {
  const parts: string[] = [];
  if (job) {
    const ref = job.externalRef?.issueIdentifier ? `${job.externalRef.issueIdentifier}: ` : '';
    parts.push(`# Ticket\n${ref}${job.title}\n\n${(job.description ?? '').slice(0, MAX_DESCRIPTION)}`.trim());
    const steps = job.steps.filter((s) => !s.cancelled)
      .map((s, i) => `${i + 1}. ${s.title}${s.goal ? ` — ${s.goal.split('\n')[0]}` : ''}`);
    if (steps.length) parts.push(`# Plan steps\n${steps.join('\n')}`);
  }
  parts.push(`# Commits on the branch, oldest first\n${git.commits.map((c, i) => `## ${i + 1}\n${c}`).join('\n\n') || '(none yet)'}`);
  if (git.dirty) parts.push('# Uncommitted work\nThe diff below also holds uncommitted changes that will be committed with this pull request.');
  parts.push(`# Diff stat\n${git.stat || '(empty)'}`);
  if (git.untracked.length) parts.push(`# New untracked files (not in the diff)\n${git.untracked.join('\n')}`);
  parts.push(`# Diff against the base${git.diffTruncated ? ' (truncated)' : ''}\n${git.diff}`);
  return parts.join('\n\n');
}

let emptyCwd: string | undefined;

export async function draftPrDescription(
  job: JobRecord | undefined,
  git: PrDraftGitContext,
  run: RunClaudeOnce = runClaudeOnce,
): Promise<PrDraft> {
  emptyCwd ??= mkdtempSync(join(tmpdir(), 'outpost-pr-draft-'));
  let res;
  try {
    res = await run(prDraftInput(job, git), {
      cwd: emptyCwd,
      model: 'sonnet',
      tools: [],
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      persistSession: false,
      extraArgs: { 'disable-slash-commands': null },
      systemPrompt: SYSTEM_PROMPT,
      outputFormat: { type: 'json_schema', schema: SCHEMA },
    }, { timeoutMs: TIMEOUT_MS });
  } catch (e) {
    throw new Error(`drafting the PR description failed: ${(e as Error).message}`);
  }
  if (!res) throw new Error('drafting the PR description timed out');
  const d = (res.subtype === 'success' ? res.structured_output : undefined) as Partial<PrDraft> | undefined;
  if (res.is_error || typeof d?.title !== 'string' || typeof d?.body !== 'string') {
    const why = res.subtype === 'success' ? res.result : res.errors.join('; ');
    throw new Error(`drafting the PR description failed: ${why || res.subtype}`);
  }
  return { title: d.title.trim(), body: d.body.trim() };
}
