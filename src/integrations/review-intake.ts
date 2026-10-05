import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { repoFromRemoteUrl } from '../git/worktree-manager.js';
import type { PrReviewIntake } from '../storage/preferences-store.js';
import type { ProposedStep } from '../work/work-types.js';

const execFileP = promisify(execFile);
const SEARCH_FIELDS = 'url,number,title,repository,author';

export interface IntakePr {
  url: string;
  number: number;
  title: string;
  repo: string;
  author: string;
}

interface GhSearchPr {
  url: string;
  number: number;
  title: string;
  repository: { nameWithOwner: string };
  author?: { login?: string };
}

export interface ReviewIntakeDeps {
  settings: () => PrReviewIntake;
  projects: () => string[];
  homeDir: string;
  createExternalJob: (input: {
    source: string;
    title: string;
    body: string;
    dedupeKey: string;
    externalRef: { url: string };
    autoPlan: false;
  }) => { jobId: string; created: boolean };
  postPlan: (jobId: string, steps: ProposedStep[]) => void;
  runGh?: (args: string[]) => Promise<string>;
  originOf?: (cwd: string) => Promise<string | null>;
}

async function defaultRunGh(args: string[]): Promise<string> {
  const { stdout } = await execFileP('gh', args, { maxBuffer: 4 * 1024 * 1024, timeout: 20_000 });
  return stdout.toString();
}

async function defaultOriginOf(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['-C', cwd, 'remote', 'get-url', 'origin']);
    return repoFromRemoteUrl(stdout);
  } catch {
    return null;
  }
}

// Opens one review job per PR the user's intake settings match, with a daemon-built plan
export class ReviewIntake {
  private readonly runGh: (args: string[]) => Promise<string>;
  private readonly originOf: (cwd: string) => Promise<string | null>;

  constructor(private readonly deps: ReviewIntakeDeps) {
    this.runGh = deps.runGh ?? defaultRunGh;
    this.originOf = deps.originOf ?? defaultOriginOf;
  }

  async runOnce(): Promise<{ outcome: 'ok' | 'error' }> {
    const { repos, reviewRequested } = this.deps.settings();
    const searches = repos.map((r) => [`--repo=${r}`, '--', '-author:@me']);
    // `user-` excludes team requests, which CODEOWNERS orgs attach to nearly every PR
    if (reviewRequested) searches.push(['--', 'user-review-requested:@me']);
    if (!searches.length) return { outcome: 'ok' };

    const byUrl = new Map<string, IntakePr>();
    let failed = false;
    for (const extra of searches) {
      try {
        for (const pr of await this.search(extra)) byUrl.set(pr.url, pr);
      } catch (e) {
        failed = true;
        console.warn(`[review-intake] gh search prs ${extra.join(' ')}: ${(e as Error).message}`);
      }
    }
    if (byUrl.size) {
      const origins = await this.projectOrigins();
      for (const pr of byUrl.values()) this.intake(pr, origins);
    }
    return { outcome: failed ? 'error' : 'ok' };
  }

  private async search(extra: string[]): Promise<IntakePr[]> {
    const raw = await this.runGh([
      'search', 'prs', '--state=open', '--draft=false', '--limit=100', '--json', SEARCH_FIELDS, ...extra,
    ]);
    return (JSON.parse(raw) as GhSearchPr[]).map((p) => ({
      url: p.url,
      number: p.number,
      title: p.title,
      repo: p.repository.nameWithOwner,
      author: p.author?.login ?? 'unknown',
    }));
  }

  private async projectOrigins(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const cwd of this.deps.projects()) {
      const repo = await this.originOf(cwd);
      if (repo && !out.has(repo.toLowerCase())) out.set(repo.toLowerCase(), cwd);
    }
    return out;
  }

  private intake(pr: IntakePr, origins: Map<string, string>): void {
    const { jobId, created } = this.deps.createExternalJob({
      source: 'pr-review',
      title: `Review ${pr.repo}#${pr.number}: ${pr.title}`,
      body: `${pr.url}\nOpened by ${pr.author}.`,
      dedupeKey: reviewDedupeKey(pr),
      externalRef: { url: pr.url },
      autoPlan: false,
    });
    if (!created) return;
    const registered = origins.get(pr.repo.toLowerCase());
    const repoCwd = registered ?? cloneDest(this.deps.projects(), this.deps.homeDir, pr.repo);
    try {
      this.deps.postPlan(jobId, reviewPlan(pr, repoCwd, !registered));
    } catch (e) {
      console.warn(`[review-intake] posting plan for ${pr.url}: ${(e as Error).message}`);
    }
  }
}

export function reviewDedupeKey(pr: Pick<IntakePr, 'repo' | 'number'>): string {
  return `pr-review-${pr.repo.replace('/', '-')}-${pr.number}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
}

// Same rule meta.orchestrate and write.add-project use, so a clone lands beside its siblings
export function cloneDest(projects: string[], homeDir: string, repo: string): string {
  const [owner, name] = repo.split('/') as [string, string];
  const counts = new Map<string, number>();
  for (const cwd of projects) counts.set(dirname(cwd), (counts.get(dirname(cwd)) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [parent, n] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    if (n > bestCount) { best = parent; bestCount = n; }
  }
  const sibling = best && join(best, name);
  return sibling && !projects.includes(sibling) ? sibling : join(homeDir, owner, name);
}

export function reviewPlan(pr: IntakePr, repoCwd: string, clone: boolean): ProposedStep[] {
  const review: ProposedStep = {
    type: 'orchestrated',
    controller: 'code.orchestrate-review',
    title: `Review ${pr.repo}#${pr.number}`,
    description: `${pr.title} — by ${pr.author}`,
    goal: `Review ${pr.repo}#${pr.number} and submit a verdict`,
    inputs: { prUrl: pr.url },
    workspace: { kind: 'readonly', repoCwd, ref: `refs/pull/${pr.number}/head` },
  };
  if (!clone) return [review];
  return [{
    type: 'action',
    action: 'write.add-project',
    title: `Add ${pr.repo}`,
    description: `Clone ${pr.repo} to ${repoCwd} and register it, so the review has a checkout`,
    goal: `${pr.repo} is cloned at ${repoCwd} and registered with Outpost`,
    inputs: { repo: pr.repo, dest: repoCwd },
    workspace: { kind: 'none' },
  }, review];
}
