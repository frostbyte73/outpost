import { clauseArgv } from '../permissions/shell-safety.js';
import { splitShellClauses } from '../permissions/shell-split.js';
import { writeFindings } from '../permissions/dangerous-writes.js';
import { isValidTmpFilePath, type PinnedCall } from './write-draft.js';
import type { EffectivePreapprovals } from './preapprovals.js';

export type PreapprovalSetting = 'push' | 'openPr' | 'replies' | 'merge' | 'syncBase';

export interface ClassifyContext {
  pre: EffectivePreapprovals;
  branch: string;
  baseBranch?: string;
  prNumber?: number;
  commentIds: ReadonlySet<number>;
  // Read from the worktree by the daemon: an uncommitted merge of origin/<baseBranch> is in progress.
  mergeFromBase?: boolean;
}

export type DraftCoverage =
  | { covered: true; settings: PreapprovalSetting[]; mergeSha?: string }
  | { covered: false; reason: string };

type Shape = { setting: PreapprovalSetting; expects: string[]; mergeSha?: string } | { miss: string };

const REPLY_ENDPOINT = /^repos\/\{owner\}\/\{repo\}\/pulls\/(\d+)\/comments\/(\d+)\/replies$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const PR_NUMBER_RE = /^[1-9]\d*$/;

// `gh` reads anything but a bare decimal as a branch name, which names some other PR.
function isPr(word: string | undefined, prNumber: number | undefined): boolean {
  return prNumber !== undefined && word !== undefined && PR_NUMBER_RE.test(word) && Number(word) === prNumber;
}

export function prNumberOf(prUrl: string | undefined): number | undefined {
  const m = prUrl?.match(/\/pull\/(\d+)(?:[/?#]|$)/);
  return m ? Number(m[1]) : undefined;
}

// `allowed` maps each accepted flag to whether it takes a value; any other flag is a miss.
function parseFlags(args: string[], allowed: Record<string, boolean>): { flags: Map<string, string>; positional: string[] } | null {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') { positional.push(...args.slice(i + 1)); break; }
    if (!a.startsWith('-')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? undefined : a.slice(eq + 1);
    if (!Object.hasOwn(allowed, name)) return null;
    if (allowed[name]) {
      const v = inline ?? args[++i];
      if (v === undefined) return null;
      flags.set(name, v);
    } else {
      if (inline !== undefined) return null;
      flags.set(name, '');
    }
  }
  return { flags, positional };
}

function commitShape(rest: string[], ctx: ClassifyContext): Shape {
  if (ctx.mergeFromBase && rest.length === 1 && rest[0] === '--no-edit') return { setting: 'syncBase', expects: [] };
  const p = parseFlags(rest, { '-m': true, '--message': true, '-F': true, '--file': true });
  if (!p || p.positional.length) return { miss: 'only `git commit -m` / `-F /tmp/…` is pre-approvable' };
  const file = p.flags.get('-F') ?? p.flags.get('--file');
  if (file !== undefined && !isValidTmpFilePath(file)) return { miss: 'commit message file must be under /tmp' };
  return { setting: 'push', expects: [] };
}

function pushShape(rest: string[], ctx: ClassifyContext): Shape {
  const p = parseFlags(rest, { '-u': false, '--set-upstream': false, '--delete': false });
  if (!p || p.positional.length !== 2 || p.positional[0] !== 'origin') {
    return { miss: 'only `git push [-u] origin <ref>` is pre-approvable' };
  }
  const ref = p.positional[1]!;
  if (!ctx.baseBranch || ctx.branch === ctx.baseBranch) return { miss: "this step's branch is its base branch" };
  if (p.flags.has('--delete')) {
    return ref === ctx.branch
      ? { setting: 'merge', expects: ['delete-ref'] }
      : { miss: `deletes ${ref}, not this step's branch` };
  }
  if (ref === ctx.branch || ref === `HEAD:${ctx.branch}`) return { setting: ctx.mergeFromBase ? 'syncBase' : 'push', expects: [] };
  if (ctx.baseBranch && ref === `HEAD:${ctx.baseBranch}` && ctx.pre.landing === 'direct') {
    return { setting: 'push', expects: ['default-branch'] };
  }
  return { miss: `pushes ${ref}, not this step's branch` };
}

function prCreateShape(rest: string[], ctx: ClassifyContext): Shape {
  const p = parseFlags(rest, {
    '--title': true, '-t': true, '--body': true, '-b': true, '--body-file': true, '-F': true,
    '--base': true, '-B': true, '--head': true, '-H': true, '--draft': false, '-d': false,
  });
  if (!p || p.positional.length) return { miss: 'unrecognised `gh pr create` flags' };
  const head = p.flags.get('--head') ?? p.flags.get('-H');
  const base = p.flags.get('--base') ?? p.flags.get('-B');
  if (head !== ctx.branch) return { miss: `--head must be ${ctx.branch}` };
  if (!ctx.baseBranch || base !== ctx.baseBranch) return { miss: `--base must be ${ctx.baseBranch ?? "the step's base branch"}` };
  return { setting: 'openPr', expects: [] };
}

function prCommentShape(rest: string[], ctx: ClassifyContext): Shape {
  const p = parseFlags(rest, { '--body': true, '-b': true, '--body-file': true, '-F': true });
  if (!p || p.positional.length !== 1) return { miss: 'unrecognised `gh pr comment` flags' };
  if (!isPr(p.positional[0], ctx.prNumber)) return { miss: "comments on a PR that is not this step's" };
  return { setting: 'replies', expects: [] };
}

function prMergeShape(rest: string[], ctx: ClassifyContext): Shape {
  const p = parseFlags(rest, {
    '--squash': false, '--merge': false, '--rebase': false, '--match-head-commit': true,
    '--subject': true, '--body-file': true,
  });
  if (!p || p.positional.length !== 1) return { miss: 'unrecognised `gh pr merge` flags' };
  const bodyFile = p.flags.get('--body-file');
  if (bodyFile !== undefined && !isValidTmpFilePath(bodyFile)) return { miss: 'merge body file must be under /tmp' };
  if (!isPr(p.positional[0], ctx.prNumber)) return { miss: "merges a PR that is not this step's" };
  const sha = p.flags.get('--match-head-commit');
  if (!sha || !SHA_RE.test(sha)) return { miss: 'a pre-approved merge needs --match-head-commit <full sha>' };
  if (['--squash', '--merge', '--rebase'].filter((f) => p.flags.has(f)).length !== 1) return { miss: 'name exactly one merge strategy' };
  return { setting: 'merge', expects: ['pr-merge'], mergeSha: sha };
}

function apiReplyShape(rest: string[], ctx: ClassifyContext): Shape {
  const p = parseFlags(rest, { '--method': true, '-X': true, '--input': true });
  if (!p || p.positional.length !== 1) return { miss: 'unrecognised `gh api` flags' };
  const method = (p.flags.get('--method') ?? p.flags.get('-X') ?? '').toUpperCase();
  const m = p.positional[0]!.match(REPLY_ENDPOINT);
  if (method !== 'POST' || !m || !p.flags.get('--input')) return { miss: 'only a review-thread reply is pre-approvable via `gh api`' };
  if (!isPr(m[1], ctx.prNumber)) return { miss: "replies on a PR that is not this step's" };
  if (!ctx.commentIds.has(Number(m[2]))) return { miss: `comment ${m[2]} is not on this step's PR` };
  return { setting: 'replies', expects: ['api-write'] };
}

function shapeOf(argv: string[], ctx: ClassifyContext): Shape {
  const [prog, sub, ...rest] = argv;
  if (prog === 'git' && sub === 'commit') return commitShape(rest, ctx);
  if (prog === 'git' && sub === 'push') return pushShape(rest, ctx);
  if (prog === 'gh' && sub === 'pr' && rest[0] === 'create') return prCreateShape(rest.slice(1), ctx);
  if (prog === 'gh' && sub === 'pr' && rest[0] === 'comment') return prCommentShape(rest.slice(1), ctx);
  if (prog === 'gh' && sub === 'pr' && rest[0] === 'merge') return prMergeShape(rest.slice(1), ctx);
  if (prog === 'gh' && sub === 'api') return apiReplyShape(rest, ctx);
  return { miss: 'no pre-approval covers this command' };
}

function classifyCall(call: PinnedCall, ctx: ClassifyContext): Shape {
  if (!call.bash) return { miss: 'tool calls are never pre-approved' };
  const clauses = splitShellClauses(call.bash.trim());
  if (!clauses || clauses.length !== 1) return { miss: 'compound commands are never pre-approved' };
  const shape = shapeOf(clauseArgv(clauses[0]!.text), ctx);
  if ('miss' in shape) return shape;
  // `push` already covers any commit + push to the step's own branch, a merge from base included.
  const granted = ctx.pre[shape.setting] || (shape.setting === 'syncBase' && ctx.pre.push);
  if (!granted) return { miss: `needs the ${shape.setting} pre-approval` };
  const unexpected = writeFindings(call.bash).filter((f) => !shape.expects.includes(f.code));
  if (unexpected.length) return { miss: unexpected.map((f) => f.message).join(' ') };
  return shape;
}

export function classifyDraft(calls: PinnedCall[], ctx: ClassifyContext): DraftCoverage {
  const settings: PreapprovalSetting[] = [];
  let mergeSha: string | undefined;
  for (const [i, c] of calls.entries()) {
    const shape = classifyCall(c, ctx);
    if ('miss' in shape) return { covered: false, reason: `${c.label ?? `call ${i + 1}`}: ${shape.miss}` };
    if (!settings.includes(shape.setting)) settings.push(shape.setting);
    if (shape.mergeSha) mergeSha = shape.mergeSha;
  }
  return mergeSha ? { covered: true, settings, mergeSha } : { covered: true, settings };
}
