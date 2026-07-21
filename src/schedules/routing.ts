import type { RunDelivery, ScheduleRecord, ScheduleRun } from './types.js';
import { whatCwd } from './types.js';
import type { SchedulesStore } from './schedules-store.js';

export interface RoutingDeps {
  // Returns undefined when no webhook is configured (routing.ts records the route as skipped
  // rather than attempting delivery). Sourced from `~/.outpost/.env`'s OUTPOST_SLACK_WEBHOOK_URL
  // by the wiring agent.
  getSlackWebhook: () => string | undefined;
  // Posts a comment against the given repo (e.g. via `gh issue comment` / `gh pr comment` —
  // the wiring agent decides which target within `repo` to hit). Must reject on failure.
  postGithubComment: (input: { repo: string; body: string }) => Promise<{ url?: string }>;
  fetchImpl?: typeof fetch;
}

function draftBody(schedule: ScheduleRecord, run: ScheduleRun): string {
  const v = run.verdict;
  if (!v) return `Scheduled run "${schedule.name}" finished with no verdict recorded.`;
  const lines = [v.summary];
  for (const f of v.findings ?? []) lines.push(`- ${f.title}${f.body ? `: ${f.body}` : ''}`);
  return lines.join('\n');
}

function slackPayload(schedule: ScheduleRecord, run: ScheduleRun): unknown {
  const shape = schedule.routing.slack?.summaryShape ?? 'digest';
  const v = run.verdict;
  if (shape === 'per-finding' && v?.findings?.length) {
    return { text: `*${schedule.name}*\n${v.findings.map((f) => `• ${f.title}`).join('\n')}` };
  }
  return { text: `*${schedule.name}*\n${v?.summary ?? 'Run finished.'}` };
}

async function routeCockpit(schedule: ScheduleRecord, run: ScheduleRun): Promise<RunDelivery['cockpit']> {
  const threshold = schedule.routing.cockpit?.confidenceThreshold;
  if (threshold === undefined || run.verdict?.confidence === undefined) return { surfaced: true };
  return { surfaced: run.verdict.confidence >= threshold };
}

async function routeSlack(schedule: ScheduleRecord, run: ScheduleRun, deps: RoutingDeps): Promise<RunDelivery['slack']> {
  if (!schedule.routing.slack) return undefined;
  const webhook = deps.getSlackWebhook();
  if (!webhook) return { status: 'skipped', reason: 'Slack delivery skipped — no webhook configured' };
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(slackPayload(schedule, run)),
    });
    if (!res.ok) return { status: 'failed', reason: `Slack webhook returned ${res.status}` };
    return { status: 'sent' };
  } catch (e) {
    return { status: 'failed', reason: (e as Error).message };
  }
}

async function routeGithub(schedule: ScheduleRecord, run: ScheduleRun, deps: RoutingDeps): Promise<RunDelivery['github']> {
  const cfg = schedule.routing.github;
  if (!cfg) return undefined;
  const repo = whatCwd(schedule.what);
  const body = draftBody(schedule, run);
  if (!repo) return { status: 'skipped', reason: 'No repo configured for GitHub routing', body };
  if (cfg.approvalBeforePosting) return { status: 'pending-approval', repo, body };
  try {
    const posted = await deps.postGithubComment({ repo, body });
    return { status: 'posted', repo, body, url: posted.url };
  } catch (e) {
    return { status: 'failed', reason: (e as Error).message, repo, body };
  }
}

export async function routeFindings(schedule: ScheduleRecord, run: ScheduleRun, deps: RoutingDeps): Promise<RunDelivery> {
  const [cockpit, slack, github] = await Promise.all([
    routeCockpit(schedule, run),
    routeSlack(schedule, run, deps),
    routeGithub(schedule, run, deps),
  ]);
  const delivery: RunDelivery = {};
  if (cockpit) delivery.cockpit = cockpit;
  if (slack) delivery.slack = slack;
  if (github) delivery.github = github;
  return delivery;
}

// Executes a previously-drafted, approval-gated GitHub post. Returns null if the run doesn't
// exist or isn't actually pending approval (double-click / already-approved guard).
export async function approveGithubPost(store: SchedulesStore, runId: string, deps: RoutingDeps): Promise<ScheduleRun | null> {
  const run = store.getRun(runId);
  if (!run?.delivery?.github || run.delivery.github.status !== 'pending-approval') return null;
  const { repo, body } = run.delivery.github;
  if (!repo || !body) return null;
  const posted = await deps.postGithubComment({ repo, body });
  return store.updateRun(runId, {
    delivery: { ...run.delivery, github: { status: 'posted', repo, body, url: posted.url } },
  });
}
