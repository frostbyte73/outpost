import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitHubApi, repoOfCwd, type GitHubRepo } from './github-api.js';
import { parsePrUrl } from '../work/pr-url.js';

// The `gh` invocations the daemon makes, answered from the REST/GraphQL API with the token in
// ~/.outpost/.env instead of the `gh` binary, so the PR watcher, review intake and PR discovery
// keep working on a machine without one.
//
// It answers argv rather than exposing typed methods on purpose: `RunGh(cwd, argv) → stdout` is
// the seam every caller and every test fake is already written against, and the output is the
// same JSON `gh` printed, so not one consumer changes. The price is that only the shapes listed
// in `ghViaApi` exist — anything else throws, loudly, rather than guessing what gh would do.

const execFileP = promisify(execFile);

export interface ShimDeps {
  api: GitHubApi;
  repoOf?: (cwd: string) => Promise<GitHubRepo>;
  // `--fill`'s commit messages, oldest first. Injected so a test needs no repository.
  commitsOf?: (cwd: string, base: string) => Promise<Commit[]>;
}

export interface Commit { subject: string; body: string }

// A failure that still printed something — `gh pr create` prints the URL before it requests
// reviewers, so a reviewer failure exits non-zero on a PR that IS open. Same fields an execFile
// rejection carries, which is what git-ops' caller already reads.
export class GhError extends Error {
  constructor(message: string, readonly stdout: string, readonly stderr: string, readonly code = 1) {
    super(message);
  }
}

interface Parsed { pos: string[]; flags: Map<string, string | true> }

const VALUE_FLAGS = new Set([
  '--json', '--head', '--limit', '--state', '-q', '--jq', '--base', '--title', '--body', '--reviewer',
]);

function parseArgs(args: string[]): Parsed {
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') { pos.push(...args.slice(i + 1)); break; }
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    if (eq > 0) { flags.set(a.slice(0, eq), a.slice(eq + 1)); continue; }
    if (VALUE_FLAGS.has(a)) { flags.set(a, args[++i] ?? ''); continue; }
    if (a.startsWith('-')) { flags.set(a, true); continue; }
    pos.push(a);
  }
  return { pos, flags };
}

function str(p: Parsed, flag: string): string | undefined {
  const v = p.flags.get(flag);
  return typeof v === 'string' ? v : undefined;
}

function unsupported(args: string[]): never {
  throw new Error(`gh ${args.join(' ')}: not supported over the GitHub API`);
}

export async function ghViaApi(deps: ShimDeps, cwd: string, args: string[]): Promise<string> {
  const { api } = deps;
  const repoOf = deps.repoOf ?? repoOfCwd;
  const p = parseArgs(args.slice(1));
  const [cmd] = args;
  const sub = p.pos[0];

  if (cmd === 'api') {
    if (p.flags.size === 0 && sub === 'user') return JSON.stringify(await api.rest('user'));
    if (p.flags.size === 1 && p.flags.get('--paginate') === true && sub && p.pos.length === 1) {
      return JSON.stringify(await api.restPaginate(await expandPlaceholders(sub, cwd, repoOf)));
    }
    return unsupported(args);
  }
  if (cmd === 'search' && sub === 'prs') return JSON.stringify(await searchPrs(api, p, args));
  if (cmd === 'pr' && sub === 'create' && p.pos.length === 1) return prCreate(deps, cwd, p, args);
  if (cmd === 'issue' && sub === 'create' && p.pos.length === 1) {
    const title = str(p, '--title');
    const body = str(p, '--body');
    if (!title || body === undefined || p.flags.size !== 2) return unsupported(args);
    const { owner, repo } = await repoOf(cwd);
    const issue = await api.rest<{ html_url: string }>(`repos/${owner}/${repo}/issues`, { method: 'POST', body: { title, body } });
    return `${issue.html_url}\n`;
  }
  if (cmd === 'pr' && sub === 'list') return JSON.stringify(await prList(api, await repoOf(cwd), p, args));
  if (cmd === 'pr' && sub === 'view' && p.pos.length === 2) return JSON.stringify(await prView(api, cwd, repoOf, p, args));
  if (cmd === 'run' && sub === 'view' && p.pos.length === 2 && /^\d+$/.test(p.pos[1]!)) {
    const { owner, repo } = await repoOf(cwd);
    const run = await api.rest<{ head_branch?: string; status?: string; conclusion?: string | null; run_attempt?: number }>(
      `repos/${owner}/${repo}/actions/runs/${p.pos[1]}`,
    );
    return JSON.stringify(pick({
      headBranch: run.head_branch, status: run.status, conclusion: run.conclusion ?? '', attempt: run.run_attempt,
    }, jsonFields(p, args)));
  }
  return unsupported(args);
}

async function expandPlaceholders(path: string, cwd: string, repoOf: (cwd: string) => Promise<GitHubRepo>): Promise<string> {
  if (!/\{owner\}|\{repo\}/.test(path)) return path;
  const { owner, repo } = await repoOf(cwd);
  return path.replace(/\{owner\}/g, owner).replace(/\{repo\}/g, repo);
}

function jsonFields(p: Parsed, args: string[]): string[] {
  const fields = str(p, '--json');
  if (!fields) return unsupported(args);
  return fields.split(',').map((f) => f.trim()).filter(Boolean);
}

function pick(obj: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (!(f in obj)) throw new Error(`gh --json field "${f}" is not supported over the GitHub API`);
    out[f] = obj[f];
  }
  return out;
}

const PR_CREATE_FLAGS = new Set(['--head', '--base', '--title', '--body', '--fill', '--reviewer']);

// `gh pr create --head <branch> [--base b] (--title t [--body x] | --fill) [--reviewer a,org/team]`,
// printing the URL like gh. Reviewers are a second call, after the PR exists — a failure there
// is a GhError carrying the URL, so the caller still sees an open PR, with a warning.
async function prCreate(deps: ShimDeps, cwd: string, p: Parsed, args: string[]): Promise<string> {
  const head = str(p, '--head');
  const fill = p.flags.get('--fill') === true;
  let title = str(p, '--title');
  const explicitBody = str(p, '--body');
  let body = explicitBody ?? '';
  if (!head || [...p.flags.keys()].some((f) => !PR_CREATE_FLAGS.has(f)) || fill === (title !== undefined)) {
    return unsupported(args);
  }
  const { owner, repo } = await (deps.repoOf ?? repoOfCwd)(cwd);
  const base = str(p, '--base')
    ?? (await deps.api.rest<{ default_branch: string }>(`repos/${owner}/${repo}`)).default_branch;
  if (fill) {
    const filled = fillFrom(await (deps.commitsOf ?? commitsSince)(cwd, base), head);
    title = filled.title;
    body = explicitBody ?? filled.body;
  }
  const pr = await deps.api.rest<{ number: number; html_url: string }>(`repos/${owner}/${repo}/pulls`, {
    method: 'POST', body: { title, body, head, base },
  });
  const stdout = `${pr.html_url}\n`;
  const reviewers = (str(p, '--reviewer') ?? '').split(',').map((r) => r.trim()).filter(Boolean);
  if (!reviewers.length) return stdout;
  try {
    await deps.api.rest(`repos/${owner}/${repo}/pulls/${pr.number}/requested_reviewers`, {
      method: 'POST',
      body: {
        reviewers: reviewers.filter((r) => !r.includes('/')),
        team_reviewers: reviewers.filter((r) => r.includes('/')).map((r) => r.split('/').pop()!),
      },
    });
  } catch (e) {
    const msg = `could not request reviewers: ${(e as Error).message}`;
    throw new GhError(msg, stdout, msg);
  }
  return stdout;
}

// gh's `--fill`: one commit is the title and body; several make the branch name the title and
// their subjects the body.
export function fillFrom(commits: Commit[], branch: string): { title: string; body: string } {
  if (commits.length === 1) return { title: commits[0]!.subject, body: commits[0]!.body };
  const words = branch.replace(/[-_]+/g, ' ').trim();
  return {
    title: words.charAt(0).toUpperCase() + words.slice(1),
    body: commits.map((c) => `- ${c.subject}`).join('\n'),
  };
}

async function commitsSince(cwd: string, base: string): Promise<Commit[]> {
  const { stdout } = await execFileP('git', ['-C', cwd, 'log', '--reverse', '--format=%s%x1f%b%x1e', `origin/${base}..HEAD`, '--'],
    { maxBuffer: 4 * 1024 * 1024, timeout: 10_000 });
  return stdout.toString().split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
    const [subject = '', body = ''] = r.split('\x1f');
    return { subject: subject.trim(), body: body.trim() };
  });
}

// `gh search prs` is the issues search endpoint with `is:pr` and gh's flags spelled as qualifiers.
// Terms after `--` are already qualifiers (`-author:@me`), and `@me` means the token's owner
// there exactly as it does for gh.
const SEARCH_QUALIFIERS: Record<string, string> = { '--author': 'author', '--repo': 'repo', '--state': 'is', '--draft': 'draft' };

async function searchPrs(api: GitHubApi, p: Parsed, args: string[]): Promise<unknown[]> {
  const terms = ['is:pr'];
  let limit = 30;
  for (const [flag, value] of p.flags) {
    if (flag === '--json') continue;
    if (flag === '--limit' && typeof value === 'string' && /^\d+$/.test(value)) { limit = Number(value); continue; }
    const q = SEARCH_QUALIFIERS[flag];
    if (!q || typeof value !== 'string') return unsupported(args);
    terms.push(`${q}:${value}`);
  }
  terms.push(...p.pos.slice(1));
  const fields = jsonFields(p, args);
  const res = await api.rest<{ items: SearchItem[] }>(
    `search/issues?q=${encodeURIComponent(terms.join(' '))}&per_page=${Math.min(Math.max(limit, 1), 100)}`,
  );
  return res.items.map((i) => {
    const nameWithOwner = i.repository_url.replace(/^https:\/\/api\.github\.com\/repos\//, '');
    return pick({
      url: i.html_url, number: i.number, title: i.title, isDraft: !!i.draft,
      repository: { name: nameWithOwner.split('/')[1] ?? '', nameWithOwner },
      author: { login: i.user?.login ?? '' }, updatedAt: i.updated_at, createdAt: i.created_at,
    }, fields);
  });
}

interface SearchItem {
  html_url: string; number: number; title: string; draft?: boolean; repository_url: string;
  user: Author | null; updated_at: string; created_at: string;
}

// `gh pr list --head <branch>` matches the head branch NAME across forks, which REST's `head=`
// filter can't (it wants `owner:branch`) — so this is GraphQL, like gh's own.
async function prList(api: GitHubApi, { owner, repo }: GitHubRepo, p: Parsed, args: string[]): Promise<unknown[]> {
  const head = str(p, '--head');
  const state = (str(p, '--state') ?? 'open').toUpperCase();
  const limit = Number(str(p, '--limit') ?? '30');
  if (!head || !['OPEN', 'CLOSED', 'MERGED'].includes(state) || !Number.isInteger(limit)) return unsupported(args);
  const fields = jsonFields(p, args);
  const data = await api.graphql<{ repository: { pullRequests: { nodes: PrNode[] } } | null }>(
    `query($owner:String!,$repo:String!,$head:String!,$states:[PullRequestState!],$n:Int!){
      repository(owner:$owner,name:$repo){
        pullRequests(headRefName:$head,states:$states,first:$n,orderBy:{field:CREATED_AT,direction:DESC}){
          nodes{ ${prSelection(fields)} } } } }`,
    { owner, repo, head, states: [state], n: Math.min(Math.max(limit, 1), 100) },
  );
  return (data.repository?.pullRequests.nodes ?? []).map((n) => pick(prFromNode(n), fields));
}

// `gh pr view <url|number|branch>`. A branch argument resolves to that branch's newest open PR,
// else its newest PR in any state, the way gh prefers an open one.
async function prView(
  api: GitHubApi, cwd: string, repoOf: (cwd: string) => Promise<GitHubRepo>, p: Parsed, args: string[],
): Promise<unknown> {
  const target = p.pos[1]!;
  const fields = jsonFields(p, args);
  const sel = prSelection(fields);
  const url = parsePrUrl(target);
  const { owner, repo } = url ?? await repoOf(cwd);
  let node: PrNode | undefined;
  if (url || /^\d+$/.test(target)) {
    const data = await api.graphql<{ repository: { pullRequest: PrNode | null } | null }>(
      `query($owner:String!,$repo:String!,$n:Int!){ repository(owner:$owner,name:$repo){ pullRequest(number:$n){ ${sel} } } }`,
      { owner, repo, n: Number(url ? url.number : target) },
    );
    node = data.repository?.pullRequest ?? undefined;
  } else {
    for (const states of [['OPEN'], null]) {
      const data = await api.graphql<{ repository: { pullRequests: { nodes: PrNode[] } } | null }>(
        `query($owner:String!,$repo:String!,$head:String!,$states:[PullRequestState!]){ repository(owner:$owner,name:$repo){
          pullRequests(headRefName:$head,states:$states,first:1,orderBy:{field:CREATED_AT,direction:DESC}){ nodes{ ${sel} } } } }`,
        { owner, repo, head: target, states },
      );
      node = data.repository?.pullRequests.nodes[0];
      if (node) break;
    }
  }
  if (!node) throw new Error(`no pull requests found for ${target}`);
  return pick(prFromNode(node), fields);
}

interface Author { login?: string }
interface CheckNode {
  __typename: string;
  name?: string; status?: string; conclusion?: string | null; detailsUrl?: string;
  checkSuite?: { workflowRun?: { workflow?: { name?: string } } | null } | null;
  context?: string; state?: string; targetUrl?: string;
}
interface PrNode {
  number?: number; url?: string; state?: string; reviewDecision?: string | null; mergeable?: string; headRefOid?: string;
  commits?: { nodes: Array<{ commit: { statusCheckRollup: { contexts: { nodes: CheckNode[] } } | null } }> };
  reviews?: { nodes: Array<{ id: string; author: Author | null; body: string; submittedAt: string; state: string }> };
  comments?: { nodes: Array<{ id: string; author: Author | null; body: string; createdAt: string; url?: string }> };
}

// The GraphQL selection for the gh `--json` fields the daemon asks for. A field not listed
// throws, here and in `pick`, rather than coming back silently missing.
const SCALAR_FIELDS = new Set(['number', 'url', 'state', 'reviewDecision', 'mergeable', 'headRefOid']);
const COMPOSITE_FIELDS: Record<string, string> = {
  statusCheckRollup: `commits(last:1){ nodes{ commit{ statusCheckRollup{ contexts(first:100){ nodes{
    __typename
    ... on CheckRun{ name status conclusion detailsUrl checkSuite{ workflowRun{ workflow{ name } } } }
    ... on StatusContext{ context state targetUrl } } } } } } }`,
  reviews: 'reviews(last:100){ nodes{ id author{ login } body submittedAt state } }',
  comments: 'comments(last:100){ nodes{ id author{ login } body createdAt url } }',
};

function prSelection(fields: string[]): string {
  return fields.map((f) => {
    if (SCALAR_FIELDS.has(f)) return f;
    const composite = COMPOSITE_FIELDS[f];
    if (!composite) throw new Error(`gh --json field "${f}" is not supported over the GitHub API`);
    return composite;
  }).join(' ');
}

// Back into the shape `gh pr view --json` prints: the rollup flattened to its contexts with the
// workflow name hoisted, and a deleted ("ghost") author as an empty login rather than null.
function prFromNode(n: PrNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of SCALAR_FIELDS) if (f in n) out[f] = (n as Record<string, unknown>)[f];
  if (n.commits) {
    const contexts = n.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
    out.statusCheckRollup = contexts.map((c) => (c.__typename === 'StatusContext'
      ? { __typename: c.__typename, context: c.context, state: c.state, targetUrl: c.targetUrl }
      : {
        __typename: c.__typename, name: c.name, workflowName: c.checkSuite?.workflowRun?.workflow?.name ?? '',
        status: c.status, conclusion: c.conclusion ?? '', detailsUrl: c.detailsUrl,
      }));
  }
  if (n.reviews) out.reviews = n.reviews.nodes.map((r) => ({ ...r, author: { login: r.author?.login ?? '' } }));
  if (n.comments) out.comments = n.comments.nodes.map((c) => ({ ...c, author: { login: c.author?.login ?? '' } }));
  return out;
}
