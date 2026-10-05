// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { renderFinding, splitTopics } from '../../src/pwa/components/work/finding.js';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { renderPlanSection } from '../../src/pwa/components/work/plan-section.js';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { renderTimelineStep } from '../../src/pwa/components/work/step-card.js';

const finding = {
  findings: 'Verified the NPE reproduces at session.go:142.',
  evidence: [{ kind: 'repo-file', source: 'session.go:142', summary: 'nil deref on close', excerpt: 'return s.conn.Close() // s.conn is nil' }],
  caveats: ['Could not check the shared config override.'],
};

describe('renderFinding', () => {
  it('returns empty string when there is no finding', () => {
    expect(renderFinding(undefined)).toBe('');
    expect(renderFinding(null)).toBe('');
  });

  it('renders the markdown writeup, evidence, and caveats', () => {
    const html = renderFinding(finding);
    expect(html).toContain('step-findings');
    expect(html).toContain('session.go:142');
    expect(html).toContain('nil deref on close');
    expect(html).toContain('shared config override');
  });

  it('renders an evidence excerpt when present', () => {
    const html = renderFinding(finding);
    expect(html).toContain('finding-evidence-excerpt');
    expect(html).toContain('s.conn is nil');
  });

  it('renders the diagram in the current theme + mode only when the finding has one and the caller gives a URL', () => {
    const url = '/api/work/jobs/j1/diagram.svg';
    document.documentElement.dataset.theme = 'plasma';
    document.documentElement.dataset.mode = 'dark';
    document.documentElement.style.setProperty('--bg', '#0a0610');
    const html = renderFinding({ ...finding, diagram: 'a -> b' }, 'Investigation', url);
    expect(html).toContain(`src="${url}?theme=plasma&amp;bg=%230a0610&amp;`);
    expect(renderFinding({ ...finding, diagram: 'a -> b' })).not.toContain('plan-diagram');
    expect(renderFinding(finding, 'Investigation', url)).not.toContain('plan-diagram');
  });

  it('uses a custom label when given, defaulting to Investigation', () => {
    expect(renderFinding(finding)).toContain('>Investigation<');
    expect(renderFinding(finding, 'Findings')).toContain('>Findings<');
  });

  it('shows only the summary and folds every topic, evidence and caveats', () => {
    const html = renderFinding({
      ...finding,
      summary: 'Nil conn on close crashes the session; guard it and add a regression test.',
      findings: 'Lead line.\n\n## Verdict\nShip it.\n\n## The code\nTraced it.',
    });
    const open = html.slice(0, html.indexOf('<details'));
    expect(open).toContain('class="finding-summary"');
    expect(open).toContain('guard it and add a regression test');
    expect(open).not.toContain('Lead line.');
    expect(open).not.toContain('Ship it.');
    expect(html).not.toMatch(/<details[^>]* open/);
    for (const t of ['Overview', 'Verdict', 'The code', 'Evidence (1)', 'Caveats (1)']) expect(html).toContain(`>${t}<`);
    expect(html).toContain('data-details-key="finding-topic-evidence"');
  });

  it('splits one level deeper when the top level holds a single heading', () => {
    const { topics } = splitTopics('## What I verified\nIntro.\n### A\na\n### B\nb');
    expect(topics.map((t: { title: string }) => t.title)).toEqual(['A', 'B']);
  });
});

describe('renderPlanSection findings', () => {
  const base = {
    id: 'j1', state: 'plan_pending_review',
    steps: [{ id: 's1', type: 'open-pr', title: 'Fix it', cancelled: false }],
    plan: { postedAt: 1, iterationsRejected: [] },
  };

  it('shows findings when the plan carries them', () => {
    const html = renderPlanSection({ ...base, plan: { ...base.plan, findings: finding } });
    expect(html).toContain('Investigation');
    expect(html).toContain('session.go:142');
  });

  it('omits the findings block when absent', () => {
    const html = renderPlanSection(base);
    expect(html).not.toContain('plan-findings');
  });

  it('drops a finished orchestrator feed but keeps a running one above the investigation', () => {
    const job = { ...base, orchestratorSessionId: 'sess-1', plan: { ...base.plan, findings: finding } };
    expect(renderPlanSection(job)).not.toContain('orchestrator-inline-session-mount--replan');
    const html = renderPlanSection({ ...job, state: 'executing', reviewingStepId: 's1' });
    const feedAt = html.indexOf('orchestrator-inline-session-mount--replan');
    expect(feedAt).toBeGreaterThanOrEqual(0);
    expect(feedAt).toBeLessThan(html.indexOf('plan-findings'));
  });
});

// Plan and Steps are one section now — a single "Plan" heading, no "Steps" label.
// Pre-approval the boxed compact index is the story; once executing the caller's
// timeline is handed in and the index is dropped so steps aren't listed twice.
describe('renderPlanSection merges plan + steps', () => {
  const executing = {
    id: 'j1', state: 'executing',
    steps: [{ id: 's1', type: 'open-pr', title: 'Fix it', cancelled: false }],
    plan: { postedAt: 1 },
  };

  it('review phase renders the boxed compact index with no timeline', () => {
    const html = renderPlanSection({ ...executing, state: 'plan_pending_review' });
    expect(html).toContain('plan-section--review');
    expect(html).toContain('plan-index');
    expect(html).not.toContain('plan-section--live');
  });

  it('executing phase drops the index and hosts the timeline under the Plan header', () => {
    const html = renderPlanSection(executing, { timelineHtml: '<div class="tl-rail">TL</div>', editing: false });
    expect(html).toContain('plan-section--live');
    expect(html).toContain('<div class="tl-rail">TL</div>');
    expect(html).not.toContain('plan-index');
    // One "Plan" label, no separate "Steps" heading.
    expect(html).toContain('>Plan<');
    expect(html).not.toContain('>Steps<');
  });

  // Regression: a step-review used to park the job in `planning`, so every completed
  // step swapped the whole timeline for the pre-execution plan card. The review now
  // rides on `executing` and only adds its own feed + caption above the timeline.
  it('keeps the timeline while the orchestrator reviews a completed step', () => {
    const html = renderPlanSection({
      ...executing,
      orchestratorSessionId: 'orch-1',
      reviewingStepId: 's1',
    }, { timelineHtml: '<div class="tl-rail">TL</div>', editing: false });
    expect(html).toContain('plan-section--live');
    expect(html).toContain('<div class="tl-rail">TL</div>');
    expect(html).not.toContain('plan-index');
    expect(html).toContain('Reviewing step 01 before continuing');
  });

  it('surfaces the Edit-plan toggle in the header while executing', () => {
    const idle = renderPlanSection(executing, { timelineHtml: '<div class="tl-rail"></div>', editing: false });
    expect(idle).toContain('data-job-action="toggle-edit-plan"');
    expect(idle).toContain('>Edit plan<');
    const editing = renderPlanSection(executing, { timelineHtml: '<div class="tl-rail"></div>', editing: true });
    expect(editing).toContain('>Done editing<');
  });
});

// Collapse moved down to each step: findings fold away once the step is done, so
// the timeline reads as name + description; live/failed steps stay expanded.
describe('renderTimelineStep findings collapse', () => {
  const job = { id: 'j1' };
  const withOutput = (state: string, extra = {}) => ({
    id: 's', type: 'action', action: 'read.investigate', title: 'Look', state, output: 'Found the bug', ...extra,
  });

  it('wraps findings in a <details> that starts open while the step runs', () => {
    const html = renderTimelineStep(job, withOutput('running', { sessionId: 'x' }), 0);
    expect(html).toContain('tl-findings');
    expect(html).toMatch(/<details class="plan-findings tl-findings" open>/);
    expect(html).toContain('Found the bug');
  });

  it('collapses findings once the step is resolved', () => {
    const html = renderTimelineStep(job, withOutput('resolved'), 0);
    expect(html).toContain('tl-findings');
    expect(html).not.toMatch(/tl-findings" open>/);
  });
});

// Same gap Critical 2 named in focusAction/stepWaitPill: a dispatch-raised draft never
// flips the PARENT orchestrated step's own `state` to `gate_pending_approval` — only the
// timeline dot's own hasUnapprovedDraft check catches it. Without that, this step (DESIGN
// §7.7 calls the timeline "the most refined thing we build") would draw a neutral hollow
// "pending" ring instead of the hot "your move" fill while a dispatch sits on its own draft.
describe('renderTimelineStep dot tone for a dispatch-raised draft', () => {
  const job = { id: 'j1' };

  it('is hot even though the parent step state is still waiting', () => {
    const html = renderTimelineStep(job, {
      id: 's1', type: 'orchestrated', controller: 'code.orchestrate-pr', title: 'Ship it',
      state: 'waiting', dispatches: [], inbox: [],
      drafts: [{ id: 'd1', raisedBy: { kind: 'dispatch', dispatchId: 'dp1' } }],
    }, 0);
    expect(html).toMatch(/<div class="tl-dot" data-tone="hot">/);
  });

  it('is pending for an ordinary waiting step with no draft', () => {
    const html = renderTimelineStep(job, {
      id: 's1', type: 'orchestrated', controller: 'code.orchestrate-pr', title: 'Ship it',
      state: 'waiting', dispatches: [], inbox: [],
    }, 0);
    expect(html).toMatch(/<div class="tl-dot" data-tone="pending">/);
  });
});
