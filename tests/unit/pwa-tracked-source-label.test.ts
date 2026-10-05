// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { renderTrackedDetail } from '../../src/pwa/components/tracked/detail.js';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { work } from '../../src/pwa/state/work.js';

describe('Tracked detail source label', () => {
  it('labels a PR-review intake job as a PR review, not Linear', () => {
    work.applyWsEvent({ jobId: 'pr-review-acme-x-1', job: {
      id: 'pr-review-acme-x-1', title: 'Review acme/x#1: y', state: 'plan_pending_review', source: 'pr-review',
      externalRef: { url: 'https://github.com/acme/x/pull/1' }, createdAt: 1, updatedAt: 1,
      events: [], steps: [], live: { orchestrator: false, stepIds: [], sessionIds: [] },
    } });
    const root = document.createElement('div');
    document.body.appendChild(root);
    renderTrackedDetail(root, 'pr-review-acme-x-1');

    const meta = root.querySelector('.tk-hdr')!.textContent!;
    expect(meta).toContain('PR review');
    expect(meta).not.toContain('Linear');
  });
});
