// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { renderTrackedDetail } from '../../src/pwa/components/tracked/detail.js';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { work } from '../../src/pwa/state/work.js';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { nav } from '../../src/pwa/state/nav.js';

// The Tracked surface has a right panel (the focus rail) and, until this toggle, no control to
// collapse it — the session view's header carried the only one.
describe('Tracked detail header', () => {
  it('toggles the right panel through the same nav flag the session view uses', () => {
    work.applyWsEvent({ jobId: 'j1', job: {
      id: 'j1', title: 'Ship it', state: 'executing', source: 'manual', createdAt: 1, updatedAt: 1,
      events: [], steps: [], live: { orchestrator: false, stepIds: [], sessionIds: [] },
    } });
    const root = document.createElement('div');
    document.body.appendChild(root);
    renderTrackedDetail(root, 'j1');

    const toggle = root.querySelector<HTMLButtonElement>('.tk-hdr [data-action="toggle-rail"]');
    expect(toggle).not.toBeNull();
    const before = !!nav.get().contextCollapsed;
    toggle!.click();
    expect(!!nav.get().contextCollapsed).toBe(!before);
    toggle!.click();
    expect(!!nav.get().contextCollapsed).toBe(before);
  });
});
