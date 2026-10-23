import { describe, it, expect } from 'vitest';
import { GitHubApi, parseGitHubRemote } from '../../src/integrations/github-api.js';
import { fillFrom, ghViaApi, GhError, type Commit } from '../../src/integrations/gh-api-shim.js';

// The daemon's `gh` calls, answered from the API instead of the binary. Each case pins the
// request that goes out and the gh-shaped JSON that comes back, since every consumer still
// parses exactly what `gh` used to print.

interface Call { url: string; method: string; body?: { query?: string; variables?: Record<string, unknown> } }

function fakeApi(respond: (c: Call) => { status?: number; json: unknown; link?: string }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call: Call = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const r = respond(call);
    return new Response(JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: r.link ? { link: r.link } : {},
    });
  }) as unknown as typeof fetch;
  return { api: new GitHubApi({ token: 'tok', fetch: fetchImpl }), calls };
}

const repoOf = async () => ({ owner: 'o', repo: 'r' });
const run = (api: GitHubApi, args: string[]) => ghViaApi({ api, repoOf }, '/tmp/repo', args).then((s) => JSON.parse(s));

describe('gh api', () => {
  it('answers `api user` from /user', async () => {
    const { api, calls } = fakeApi(() => ({ json: { login: 'Me' } }));
    expect(await run(api, ['api', 'user'])).toEqual({ login: 'Me' });
    expect(calls[0]!.url).toBe('https://api.github.com/user');
  });

  it('follows every page of a --paginate list into one array', async () => {
    const { api, calls } = fakeApi((c) => (c.url.includes('page=2')
      ? { json: [{ id: 2 }] }
      : { json: [{ id: 1 }], link: '<https://api.github.com/repos/o/r/pulls/7/comments?per_page=100&page=2>; rel="next"' }));
    expect(await run(api, ['api', 'repos/o/r/pulls/7/comments', '--paginate'])).toEqual([{ id: 1 }, { id: 2 }]);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.github.com/repos/o/r/pulls/7/comments?per_page=100',
      'https://api.github.com/repos/o/r/pulls/7/comments?per_page=100&page=2',
    ]);
  });

  it('fills {owner}/{repo} from the checkout, as gh does', async () => {
    const { api, calls } = fakeApi(() => ({ json: [] }));
    await run(api, ['api', 'repos/{owner}/{repo}/pulls/7/files', '--paginate']);
    expect(calls[0]!.url).toBe('https://api.github.com/repos/o/r/pulls/7/files?per_page=100');
  });

  it('throws GitHub\'s own message on an HTTP error, like a failed exec', async () => {
    const { api } = fakeApi(() => ({ status: 404, json: { message: 'Not Found' } }));
    await expect(run(api, ['api', 'user'])).rejects.toThrow(/HTTP 404 — Not Found/);
  });
});

describe('gh pr list / pr view', () => {
  it('finds a PR by head branch name over GraphQL, open by default', async () => {
    const { api, calls } = fakeApi(() => ({
      json: { data: { repository: { pullRequests: { nodes: [{ url: 'https://github.com/o/r/pull/7' }] } } } },
    }));
    expect(await run(api, ['pr', 'list', '--head', 'fix/x', '--json', 'url', '--limit', '1']))
      .toEqual([{ url: 'https://github.com/o/r/pull/7' }]);
    expect(calls[0]!.body!.variables).toEqual({ owner: 'o', repo: 'r', head: 'fix/x', states: ['OPEN'], n: 1 });
  });

  it('reshapes a PR view into the JSON gh prints, rollup and ghost authors included', async () => {
    const { api, calls } = fakeApi(() => ({
      json: {
        data: {
          repository: {
            pullRequest: {
              number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', reviewDecision: null,
              mergeable: 'MERGEABLE', headRefOid: 'abc',
              commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
                { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: null, detailsUrl: 'https://x/1',
                  checkSuite: { workflowRun: { workflow: { name: 'CI' } } } },
                { __typename: 'StatusContext', context: 'deploy', state: 'SUCCESS', targetUrl: 'https://x/2' },
              ] } } } }] },
              reviews: { nodes: [{ id: 'R1', author: null, body: 'lgtm', submittedAt: 't', state: 'APPROVED' }] },
              comments: { nodes: [{ id: 'C1', author: { login: 'a' }, body: 'hi', createdAt: 't', url: 'u' }] },
            },
          },
        },
      },
    }));
    const view = await run(api, [
      'pr', 'view', 'https://github.com/o/r/pull/7',
      '--json', 'number,url,state,reviewDecision,mergeable,headRefOid,statusCheckRollup,reviews,comments',
    ]);
    expect(calls[0]!.body!.variables).toEqual({ owner: 'o', repo: 'r', n: 7 });
    expect(view).toEqual({
      number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', reviewDecision: null,
      mergeable: 'MERGEABLE', headRefOid: 'abc',
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'IN_PROGRESS', conclusion: '', detailsUrl: 'https://x/1' },
        { __typename: 'StatusContext', context: 'deploy', state: 'SUCCESS', targetUrl: 'https://x/2' },
      ],
      reviews: [{ id: 'R1', author: { login: '' }, body: 'lgtm', submittedAt: 't', state: 'APPROVED' }],
      comments: [{ id: 'C1', author: { login: 'a' }, body: 'hi', createdAt: 't', url: 'u' }],
    });
  });

  it('returns only the fields asked for, and resolves a bare number against the checkout', async () => {
    const { api, calls } = fakeApi(() => ({ json: { data: { repository: { pullRequest: { state: 'MERGED' } } } } }));
    expect(await run(api, ['pr', 'view', '12', '--json', 'state'])).toEqual({ state: 'MERGED' });
    expect(calls[0]!.body!.variables).toEqual({ owner: 'o', repo: 'r', n: 12 });
    expect(calls[0]!.body!.query).not.toContain('statusCheckRollup');
  });

  it('fails a missing PR rather than printing an empty object', async () => {
    const { api } = fakeApi(() => ({ json: { data: { repository: { pullRequests: { nodes: [] } } } } }));
    await expect(run(api, ['pr', 'view', 'fix/x', '--json', 'url'])).rejects.toThrow(/no pull requests found/);
  });

  it('surfaces a GraphQL error as a failure', async () => {
    const { api } = fakeApi(() => ({ json: { errors: [{ message: 'Could not resolve to a Repository' }] } }));
    await expect(run(api, ['pr', 'view', '1', '--json', 'url'])).rejects.toThrow(/Could not resolve/);
  });
});

describe('gh run view', () => {
  it('maps the run onto gh\'s field names', async () => {
    const { api, calls } = fakeApi(() => ({
      json: { head_branch: 'fix/x', status: 'completed', conclusion: 'failure', run_attempt: 1 },
    }));
    expect(await run(api, ['run', 'view', '42', '--json', 'headBranch,status,conclusion,attempt']))
      .toEqual({ headBranch: 'fix/x', status: 'completed', conclusion: 'failure', attempt: 1 });
    expect(calls[0]!.url).toBe('https://api.github.com/repos/o/r/actions/runs/42');
  });
});

describe('gh search prs', () => {
  const item = {
    html_url: 'https://github.com/o/r/pull/3', number: 3, title: 'T', draft: false,
    repository_url: 'https://api.github.com/repos/o/r', user: { login: 'a' },
    updated_at: '2026-01-02T00:00:00Z', created_at: '2026-01-01T00:00:00Z',
  };

  it('spells the user-PRs query as search qualifiers and maps items onto gh\'s fields', async () => {
    const { api, calls } = fakeApi(() => ({ json: { items: [item] } }));
    const out = await run(api, [
      'search', 'prs', '--author=@me', '--state=open', '--limit=100',
      '--json', 'url,title,number,repository,isDraft,updatedAt,createdAt',
    ]);
    expect(decodeURIComponent(calls[0]!.url)).toBe(
      'https://api.github.com/search/issues?q=is:pr author:@me is:open&per_page=100',
    );
    expect(out).toEqual([{
      url: item.html_url, title: 'T', number: 3, repository: { name: 'r', nameWithOwner: 'o/r' },
      isDraft: false, updatedAt: item.updated_at, createdAt: item.created_at,
    }]);
  });

  it('passes the terms after -- through, for review intake', async () => {
    const { api, calls } = fakeApi(() => ({ json: { items: [{ ...item, user: null }] } }));
    const out = await run(api, [
      'search', 'prs', '--state=open', '--draft=false', '--limit=100', '--json', 'url,number,title,repository,author',
      '--repo=o/r', '--', '-author:@me',
    ]);
    expect(decodeURIComponent(calls[0]!.url)).toBe(
      'https://api.github.com/search/issues?q=is:pr is:open draft:false repo:o/r -author:@me&per_page=100',
    );
    expect(out[0].author).toEqual({ login: '' });
  });
});

describe('gh pr create / issue create', () => {
  const commits: Commit[] = [{ subject: 'Fix the thing', body: 'Because.' }];
  const create = (api: GitHubApi, args: string[], cs = commits) =>
    ghViaApi({ api, repoOf, commitsOf: async () => cs }, '/tmp/repo', args);
  const pr = { number: 9, html_url: 'https://github.com/o/r/pull/9' };

  it('opens the PR and prints its URL, the way gh does', async () => {
    const { api, calls } = fakeApi(() => ({ json: pr }));
    expect(await create(api, ['pr', 'create', '--head', 'fix/x', '--base', 'main', '--title', 'T', '--body', 'B']))
      .toBe('https://github.com/o/r/pull/9\n');
    expect(calls).toEqual([{
      url: 'https://api.github.com/repos/o/r/pulls', method: 'POST',
      body: { title: 'T', body: 'B', head: 'fix/x', base: 'main' },
    }]);
  });

  it('--fill takes the commit messages, and an absent --base means the default branch', async () => {
    const { api, calls } = fakeApi((c) => (c.method === 'GET' ? { json: { default_branch: 'trunk' } } : { json: pr }));
    await create(api, ['pr', 'create', '--head', 'fix/x', '--fill']);
    expect(calls[0]!.url).toBe('https://api.github.com/repos/o/r');
    expect(calls[1]!.body).toEqual({ title: 'Fix the thing', body: 'Because.', head: 'fix/x', base: 'trunk' });
  });

  it('an explicit --body overrides the one --fill would take, as in gh', async () => {
    const { api, calls } = fakeApi(() => ({ json: pr }));
    await create(api, ['pr', 'create', '--head', 'fix/x', '--base', 'main', '--fill', '--body', 'Mine.']);
    expect(calls[0]!.body).toEqual({ title: 'Fix the thing', body: 'Mine.', head: 'fix/x', base: 'main' });
  });

  it('requests users and teams once the PR exists', async () => {
    const { api, calls } = fakeApi(() => ({ json: pr }));
    await create(api, ['pr', 'create', '--head', 'fix/x', '--base', 'main', '--fill', '--reviewer', 'alice,livekit/infra']);
    expect(calls[1]).toEqual({
      url: 'https://api.github.com/repos/o/r/pulls/9/requested_reviewers', method: 'POST',
      body: { reviewers: ['alice'], team_reviewers: ['infra'] },
    });
  });

  it('reports a reviewer failure as an error that still carries the open PR\'s URL', async () => {
    const { api } = fakeApi((c) => (c.url.endsWith('requested_reviewers')
      ? { status: 422, json: { message: 'Reviews may only be requested from collaborators' } }
      : { json: pr }));
    const err = await create(api, ['pr', 'create', '--head', 'fix/x', '--base', 'main', '--fill', '--reviewer', 'bob'])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GhError);
    expect((err as GhError).stdout).toBe('https://github.com/o/r/pull/9\n');
    expect((err as GhError).stderr).toMatch(/collaborators/);
  });

  it('refuses a create it cannot honour exactly', async () => {
    const { api, calls } = fakeApi(() => ({ json: pr }));
    await expect(create(api, ['pr', 'create', '--head', 'x', '--title', 'T', '--fill'])).rejects.toThrow(/not supported/);
    await expect(create(api, ['pr', 'create', '--title', 'T'])).rejects.toThrow(/not supported/);
    await expect(create(api, ['pr', 'create', '--head', 'x', '--fill', '--draft'])).rejects.toThrow(/not supported/);
    expect(calls).toHaveLength(0);
  });

  it('files an issue and prints its URL', async () => {
    const { api, calls } = fakeApi(() => ({ json: { html_url: 'https://github.com/o/r/issues/4' } }));
    expect(await create(api, ['issue', 'create', '--title', 'Outpost scheduled finding', '--body', 'x']))
      .toBe('https://github.com/o/r/issues/4\n');
    expect(calls[0]).toEqual({
      url: 'https://api.github.com/repos/o/r/issues', method: 'POST', body: { title: 'Outpost scheduled finding', body: 'x' },
    });
  });

  it('fills several commits the way gh does: branch name as title, subjects as body', () => {
    expect(fillFrom([{ subject: 'a', body: '' }, { subject: 'b', body: 'x' }], 'fix/agent-outbound_call'))
      .toEqual({ title: 'Fix/agent outbound call', body: '- a\n- b' });
  });
});

describe('what the shim does not know', () => {
  it('refuses an unlisted command or --json field instead of guessing', async () => {
    const { api, calls } = fakeApi(() => ({ json: {} }));
    await expect(run(api, ['repo', 'view'])).rejects.toThrow(/not supported/);
    await expect(run(api, ['api', '--method', 'POST', 'repos/o/r/issues'])).rejects.toThrow(/not supported/);
    await expect(run(api, ['pr', 'view', '1', '--json', 'files'])).rejects.toThrow(/"files" is not supported/);
    expect(calls).toHaveLength(0);
  });
});

describe('parseGitHubRemote', () => {
  it('reads every github.com spelling and nothing else', () => {
    for (const url of [
      'git@github.com:livekit/outpost.git', 'https://github.com/livekit/outpost.git',
      'https://github.com/livekit/outpost', 'ssh://git@github.com/livekit/outpost.git',
      'https://x-access-token:abc@github.com/livekit/outpost.git\n',
    ]) {
      expect(parseGitHubRemote(url), url).toEqual({ owner: 'livekit', repo: 'outpost' });
    }
    expect(parseGitHubRemote('git@gitlab.com:livekit/outpost.git')).toBeUndefined();
    expect(parseGitHubRemote('https://github.com.evil.com/livekit/outpost')).toBeUndefined();
  });
});
