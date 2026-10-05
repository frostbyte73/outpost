import { describe, it, expect, vi } from 'vitest';
import { ReviewIntake, cloneDest, reviewDedupeKey } from '../../src/integrations/review-intake.js';
import type { ProposedStep } from '../../src/work/work-types.js';

function ghPr(repo: string, number: number) {
  return {
    url: `https://github.com/${repo}/pull/${number}`, number, title: `PR ${number}`,
    repository: { nameWithOwner: repo }, author: { login: 'lukasIO' },
  };
}

interface HarnessOpts {
  repos?: string[];
  reviewRequested?: boolean;
  results?: Record<string, unknown[] | Error>;
  projects?: Record<string, string | null>;
  existing?: string[];
  postPlan?: (jobId: string, steps: ProposedStep[]) => void;
}

function harness(opts: HarnessOpts) {
  const calls: string[][] = [];
  const created: string[] = [];
  const plans = new Map<string, ProposedStep[]>();
  const existing = new Set(opts.existing ?? []);
  const intake = new ReviewIntake({
    settings: () => ({ repos: opts.repos ?? [], reviewRequested: opts.reviewRequested ?? false }),
    projects: () => Object.keys(opts.projects ?? {}),
    homeDir: '/home/testuser',
    runGh: async (args) => {
      calls.push(args);
      const key = args.find((a) => a.startsWith('--repo=') || a.startsWith('user-review-requested:'))!;
      const r = opts.results?.[key] ?? [];
      if (r instanceof Error) throw r;
      return JSON.stringify(r);
    },
    originOf: async (cwd) => opts.projects?.[cwd] ?? null,
    createExternalJob: (input) => {
      if (existing.has(input.dedupeKey)) return { jobId: input.dedupeKey, created: false };
      existing.add(input.dedupeKey);
      created.push(input.dedupeKey);
      return { jobId: input.dedupeKey, created: true };
    },
    postPlan: opts.postPlan ?? ((jobId, steps) => { plans.set(jobId, steps); }),
  });
  return { intake, calls, created, plans };
}

describe('ReviewIntake', () => {
  it('makes no gh call when both modes are off', async () => {
    const h = harness({});
    expect(await h.intake.runOnce()).toEqual({ outcome: 'ok' });
    expect(h.calls).toEqual([]);
  });

  it('searches each watched repo excluding your own PRs, and direct review requests when on', async () => {
    const h = harness({ repos: ['frostbyte73/outpost'], reviewRequested: true });
    await h.intake.runOnce();
    const base = ['search', 'prs', '--state=open', '--draft=false', '--limit=100', '--json', 'url,number,title,repository,author'];
    expect(h.calls).toEqual([
      [...base, '--repo=frostbyte73/outpost', '--', '-author:@me'],
      [...base, '--', 'user-review-requested:@me'],
    ]);
  });

  it('creates one job for a PR both searches return', async () => {
    const pr = ghPr('frostbyte73/outpost', 16);
    const h = harness({
      repos: ['frostbyte73/outpost'], reviewRequested: true,
      results: { '--repo=frostbyte73/outpost': [pr], 'user-review-requested:@me': [pr] },
    });
    await h.intake.runOnce();
    expect(h.created).toEqual(['pr-review-frostbyte73-outpost-16']);
  });

  it('posts no plan for a PR whose job already exists', async () => {
    const h = harness({
      repos: ['frostbyte73/outpost'],
      results: { '--repo=frostbyte73/outpost': [ghPr('frostbyte73/outpost', 16)] },
      existing: ['pr-review-frostbyte73-outpost-16'],
    });
    await h.intake.runOnce();
    expect(h.plans.size).toBe(0);
  });

  it('plans a single readonly review on the PR ref for a registered repo, matched case-insensitively', async () => {
    const h = harness({
      repos: ['frostbyte73/outpost'],
      results: { '--repo=frostbyte73/outpost': [ghPr('frostbyte73/outpost', 16)] },
      projects: { '/src/outpost': 'Frostbyte73/Outpost' },
    });
    await h.intake.runOnce();
    const steps = h.plans.get('pr-review-frostbyte73-outpost-16')!;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      type: 'orchestrated',
      controller: 'code.orchestrate-review',
      inputs: { prUrl: 'https://github.com/frostbyte73/outpost/pull/16' },
      workspace: { kind: 'readonly', repoCwd: '/src/outpost', ref: 'refs/pull/16/head' },
    });
  });

  it('prepends add-project for an unregistered repo and reviews against its clone', async () => {
    const h = harness({
      reviewRequested: true,
      results: { 'user-review-requested:@me': [ghPr('livekit/protocol', 482)] },
      projects: { '/src/outpost': 'frostbyte73/outpost', '/src/broken': null },
    });
    await h.intake.runOnce();
    const steps = h.plans.get('pr-review-livekit-protocol-482')!;
    expect(steps.map((s) => s.type)).toEqual(['action', 'orchestrated']);
    expect(steps[0]).toMatchObject({ action: 'write.add-project', inputs: { repo: 'livekit/protocol', dest: '/src/protocol' } });
    expect(steps[1]).toMatchObject({ workspace: { kind: 'readonly', repoCwd: '/src/protocol', ref: 'refs/pull/482/head' } });
  });

  it('keeps going when one search fails, and reports the run as an error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness({
      repos: ['gone/repo', 'frostbyte73/outpost'],
      results: { '--repo=gone/repo': new Error('HTTP 404'), '--repo=frostbyte73/outpost': [ghPr('frostbyte73/outpost', 16)] },
    });
    expect(await h.intake.runOnce()).toEqual({ outcome: 'error' });
    expect(h.created).toEqual(['pr-review-frostbyte73-outpost-16']);
  });

  it('keeps intaking the rest when posting one plan throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const posted: string[] = [];
    const h = harness({
      repos: ['frostbyte73/outpost'],
      results: { '--repo=frostbyte73/outpost': [ghPr('frostbyte73/outpost', 15), ghPr('frostbyte73/outpost', 16)] },
      postPlan: (jobId) => {
        if (jobId.endsWith('-15')) throw new Error('bad workspace');
        posted.push(jobId);
      },
    });
    await h.intake.runOnce();
    expect(posted).toEqual(['pr-review-frostbyte73-outpost-16']);
  });
});

describe('reviewDedupeKey', () => {
  it('produces a path-safe key createExternalJob accepts', () => {
    const key = reviewDedupeKey({ repo: 'Foo.Bar/My_Repo', number: 3 });
    expect(key).toBe('pr-review-foo.bar-my_repo-3');
    expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });
});

describe('cloneDest', () => {
  it('clones next to the most registered projects', () => {
    expect(cloneDest(['/src/a', '/src/b', '/other/c'], '/home/testuser', 'livekit/protocol')).toBe('/src/protocol');
  });

  it('falls back to $HOME/<owner>/<repo> when the sibling path is a registered checkout of another repo', () => {
    expect(cloneDest(['/src/a', '/src/protocol'], '/home/testuser', 'livekit/protocol')).toBe('/home/testuser/livekit/protocol');
  });

  it('falls back to $HOME/<owner>/<repo> with no registered projects', () => {
    expect(cloneDest([], '/home/testuser', 'livekit/protocol')).toBe('/home/testuser/livekit/protocol');
  });
});
