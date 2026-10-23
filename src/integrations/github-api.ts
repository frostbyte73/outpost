import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const API_ROOT = 'https://api.github.com';

export interface GitHubRepo { owner: string; repo: string }

export interface GitHubApiOpts {
  token: string;
  fetch?: typeof fetch;
  timeout?: number;
}

// The token the daemon talks to GitHub with: `GITHUB_TOKEN` (what ~/.outpost/.env documents),
// else `GH_TOKEN` (gh's own spelling). Read per call, not at import — env-file.ts populates
// process.env after this module may already have loaded.
export function githubToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined;
}

// A thin REST + GraphQL client over fetch. Errors throw with GitHub's own message, the way a
// failed `gh` exec did, so every caller's existing catch/backoff keeps meaning what it meant.
export class GitHubApi {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GitHubApiOpts) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async rest<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await this.request(path.startsWith('http') ? path : `${API_ROOT}/${path.replace(/^\//, '')}`, init);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  // Every page of a list endpoint, concatenated, following `Link: rel="next"`.
  async restPaginate<T = unknown>(path: string): Promise<T[]> {
    const sep = path.includes('?') ? '&' : '?';
    let url: string | undefined = `${API_ROOT}/${path.replace(/^\//, '')}${/[?&]per_page=/.test(path) ? '' : `${sep}per_page=100`}`;
    const out: T[] = [];
    while (url) {
      const res = await this.request(url, {});
      const page = await res.json() as T[] | { items?: T[] };
      out.push(...(Array.isArray(page) ? page : page.items ?? []));
      url = nextLink(res.headers.get('link'));
    }
    return out;
  }

  async graphql<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.request(`${API_ROOT}/graphql`, { method: 'POST', body: { query, variables } });
    const json = await res.json() as { data?: T; errors?: Array<{ message?: string }> };
    if (json.errors?.length) throw new Error(`GitHub GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
    return json.data as T;
  }

  private async request(url: string, init: { method?: string; body?: unknown }): Promise<Response> {
    const res = await this.fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(this.opts.timeout ?? 15_000),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = ((await res.json()) as { message?: string }).message ?? ''; } catch { /* non-JSON body */ }
      throw new Error(`GitHub API ${init.method ?? 'GET'} ${url.replace(API_ROOT, '')}: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
    }
    return res;
  }
}

function nextLink(header: string | null): string | undefined {
  return header?.split(',').map((p) => /<([^>]+)>;\s*rel="next"/.exec(p)?.[1]).find(Boolean);
}

// owner/repo out of a GitHub remote URL in any of the spellings git accepts for github.com.
export function parseGitHubRemote(url: string): GitHubRepo | undefined {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : undefined;
}

// The repository `gh` would have resolved from `cwd`: origin's. A checkout whose origin isn't on
// github.com has no answer here, which fails the call the way `gh` failed in one.
export async function repoOfCwd(cwd: string): Promise<GitHubRepo> {
  const { stdout } = await execFileP('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { timeout: 5_000 });
  const repo = parseGitHubRemote(stdout.toString());
  if (!repo) throw new Error(`origin of ${cwd} is not a github.com repository: ${stdout.toString().trim()}`);
  return repo;
}
