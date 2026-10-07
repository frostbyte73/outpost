// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { launchQueueParts, usagePopoverHtml, queueActionFor, queueToggle, queueTag, iconPause, iconPlay, heldWindow } from '../../src/pwa/utils/usage-bar.js';

describe('launchQueueParts — what a hold means', () => {
  it('is null before the daemon reports the queue, or while it just runs', () => {
    expect(launchQueueParts(null)).toBeNull();
    expect(launchQueueParts({ paused: false, parked: 0, reason: null, opensAt: null })).toBeNull();
  });

  it('says how many a budget hold keeps, why and when it opens', () => {
    const p = launchQueueParts({ paused: false, parked: 6, reason: 'Waiting — 7d on course for 140% by reset (60% used, 4d left)', opensAt: Date.now() + 4 * 3600_000, blocker: 'seven_day' });
    expect(p.head).toBe('Held · 6 waiting');
    expect(p.why).toMatch(/^7d on course for 140% by reset \(60% used, 4d left\) · opens in [34]h/);
  });
});

describe('usage popover — the Job slots block', () => {
  const q = (o: object) => ({ paused: false, parked: 0, reason: null, opensAt: null, active: 0, slots: 2, ...o });
  const host = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return d; };

  it('replaces the queue line: a bar of running job turns against the slot cap', () => {
    const d = host(usagePopoverHtml(undefined, q({ active: 1, slots: 2 })));
    expect(d.querySelector('.o-usage-queue')).toBeNull();
    const block = [...d.querySelectorAll('.o-usage-pop-block')].find((b) => b.textContent!.includes('Job slots'))!;
    expect(block.querySelector('.o-usage-pop-v')!.textContent).toBe('1 of 2 running · 0 waiting');
    expect((block.querySelector('.o-usage-pop-fill') as HTMLElement).style.width).toBe('50%');
  });

  it('clamps the bar when user launches overfill the cap, and says the real count', () => {
    const d = host(usagePopoverHtml(undefined, q({ active: 3, slots: 2, parked: 1 })));
    const block = [...d.querySelectorAll('.o-usage-pop-block')].find((b) => b.textContent!.includes('Job slots'))!;
    expect(block.textContent).toContain('3 of 2 running · 1 waiting');
    expect((block.querySelector('.o-usage-pop-fill') as HTMLElement).style.width).toBe('100%');
  });

  it('carries the pause/resume only where asked (the mobile sheet)', () => {
    expect(usagePopoverHtml(undefined, q({}))).not.toContain('data-queue-action');
    const d = host(usagePopoverHtml(undefined, q({ paused: true }), { queueToggle: true }));
    expect(d.textContent).toContain('0 of 2 running · 0 waiting · paused');
    expect(queueActionFor(d.querySelector('[data-queue-action] svg'))).toBe('resume');
  });

  it('is absent until the daemon reports its slots', () => {
    expect(usagePopoverHtml(undefined, null)).not.toContain('Job slots');
  });
});

describe('queueTag — the word beside the sidebar wordmark', () => {
  it('says nothing while the queue just runs', () => {
    expect(queueTag(null)).toBeNull();
    expect(queueTag({ paused: false, parked: 0, reason: null, opensAt: null })).toBeNull();
  });

  it('reads paused for the user\'s pause, and held when the budget keeps launches back', () => {
    expect(queueTag({ paused: true, parked: 2, reason: 'Job queue paused', opensAt: null }))
      .toEqual({ text: 'paused', tone: 'paused', title: 'Job queue paused · 2 waiting' });
    const held = queueTag({ paused: false, parked: 4, reason: 'Waiting — 7d on course for 95% by reset (50% used, 3d left)', opensAt: null, blocker: 'seven_day' });
    expect(held).toMatchObject({ text: 'held', tone: 'held' });
    expect(held!.title).toBe('Held · 4 waiting — 7d on course for 95% by reset (50% used, 3d left)');
  });

  it('says nothing when only the slots are full, or the budget is being ignored', () => {
    expect(queueTag({ paused: false, parked: 3, reason: '2/2 slots busy', opensAt: null, active: 2, slots: 2, blocker: null })).toBeNull();
    expect(queueTag({ paused: false, parked: 3, reason: 'Usage limit ignored', opensAt: null, blocker: 'seven_day', ignoreBudgetUntil: Date.now() + 3600_000 })).toBeNull();
  });
});

describe('usagePopoverHtml — the window holding the queue', () => {
  const au = { five_hour: { used_percentage: 20, resets_at: 2e9 }, seven_day: { used_percentage: 60, resets_at: 2e9 } };
  const q = { paused: false, parked: 2, reason: null, opensAt: null, blocker: 'seven_day' };
  it('tints the blocking window and offers to ignore it, nothing on the other', () => {
    const html = usagePopoverHtml(au, q);
    expect(heldWindow(q)).toBe('seven_day');
    expect(html.match(/is-blocking/g)).toHaveLength(1);
    expect(html).toMatch(/is-blocking has-tip"[\s\S]*Weekly window[\s\S]*o-usage-pop-tip[\s\S]*data-queue-action="ignore-budget">Ignore limit for 1h/);
    expect(html).not.toContain('holding the queue');
  });
  it('offers Restore instead while ignored, and nothing is held', () => {
    const ignored = { ...q, ignoreBudgetUntil: Date.now() + 3_600_000 };
    expect(heldWindow(ignored)).toBeNull();
    const html = usagePopoverHtml(au, ignored);
    expect(html).not.toContain('is-blocking');
    expect(html).toMatch(/has-tip"[\s\S]*Ignored until [\s\S]*data-queue-action="restore-budget">Restore/);
  });
});

describe('queueToggle — the sidebar nav item', () => {
  it('is a pause icon while running and a play icon while paused, with the whole state as its title', () => {
    const running = queueToggle({ paused: false, parked: 0, reason: null, opensAt: null });
    expect(running).toMatchObject({ action: 'pause', label: 'Pause queue', paused: false, title: 'Job queue running — pause it' });
    expect(running.icon).toBe(iconPause());
    const paused = queueToggle({ paused: true, parked: 3, reason: 'Job queue paused', opensAt: null });
    expect(paused).toMatchObject({ action: 'resume', label: 'Resume queue', paused: true, title: 'Job queue paused · 3 waiting — resume it' });
    expect(paused.icon).toBe(iconPlay());
  });
});

// request() prefixes /api/work itself; a path that repeats it 404s (Run all shipped that way once).
describe('queue control requests', () => {
  it('hit the daemon\'s launch-queue routes', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => { urls.push(url); return new Response('{}', { status: 200 }); }) as never;
    // @ts-expect-error PWA modules are plain JS; tests import them at runtime.
    const { workApi } = await import('../../src/pwa/net/work.js');
    await workApi.runAllQueued();
    await workApi.pauseQueue();
    await workApi.resumeQueue();
    await workApi.ignoreQueueBudget(true);
    expect(urls).toEqual(['/api/work/launch-queue/run-all', '/api/work/launch-queue/pause', '/api/work/launch-queue/resume', '/api/work/launch-queue/ignore-budget']);
  });
});
