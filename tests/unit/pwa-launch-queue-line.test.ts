// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { launchQueueParts, launchQueueHtml } from '../../src/pwa/utils/usage-bar.js';

describe('launch-queue line under the usage meter', () => {
  it('shows nothing while nothing waits', () => {
    expect(launchQueueParts(null)).toBeNull();
    expect(launchQueueHtml({ parked: 0, reason: null, opensAt: null })).toBe('');
  });

  it('says how many wait, why, and when it opens', () => {
    const p = launchQueueParts({ parked: 6, reason: 'Waiting — 7d on course for 140% by reset (60% used, 4d left)', opensAt: Date.now() + 4 * 3600_000 });
    expect(p.head).toBe('Paused · 6 waiting');
    expect(p.why).toMatch(/^7d on course for 140% by reset \(60% used, 4d left\) · opens in [34]h/);
  });

  it('has no opening time for busy slots, and offers Run all', () => {
    expect(launchQueueParts({ parked: 1, reason: '2/2 slots busy', opensAt: null }).why).toBe('2/2 slots busy');
    expect(launchQueueHtml({ parked: 1, reason: '2/2 slots busy', opensAt: null })).toContain('data-run-all-queued');
  });
});
