// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { renderDetail } from '../../src/pwa/components/cockpit/index.js';
// @ts-expect-error runtime JS import
import { work } from '../../src/pwa/state/work.js';

const NO_LIVE = { orchestrator: false, stepIds: [], sessionIds: [], interactiveSessionIds: [] };
const flush = () => new Promise((r) => setTimeout(r, 30));

describe('cockpit board', () => {
  it('renders a parked job row once, and keeps the node across an unrelated repaint', async () => {
    work.applyWsEvent({ jobId: 'jb', job: {
      id: 'jb', title: 'Merge-gate cleanup', state: 'executing', source: 'manual', createdAt: 1, updatedAt: 1,
      events: [], live: NO_LIVE,
      steps: [{ id: 's1', type: 'orchestrated', controller: 'code.orchestrate-pr', title: 'Fix', state: 'waiting',
        phase: 'pr_open', waitingOn: { reason: 'waiting on CI' }, dispatches: [], drafts: [], createdAt: 1, updatedAt: 1,
        sessionId: 'x', pr: { prUrl: 'https://github.com/o/r/pull/412' } }],
    } });
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const unmount = renderDetail(mount);
    await flush();

    const row = mount.querySelector('[data-group="started"] .ckb-item[data-row-key="job:jb"]')!;
    expect(row.getAttribute('data-tone')).toBe('parked');
    expect(row.querySelector('.ckb-status')!.textContent).toContain('PR #412 · waiting on CI');
    expect(row.querySelector('.ckb-act button')).toBeNull();

    work.applyWsEvent({ jobId: 'other', job: { id: 'other', title: 'x', state: 'done', source: 'manual', createdAt: 2, updatedAt: 2, events: [], steps: [], live: NO_LIVE } });
    await flush();
    expect(mount.querySelector('.ckb-item[data-row-key="job:jb"]')).toBe(row);
    unmount();
  });

  it('a paint scheduled before teardown never rebuilds the board', async () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const unmount = renderDetail(mount);
    await flush();
    expect(mount.querySelectorAll('.ckb-item').length).toBeGreaterThan(0);
    work.applyWsEvent({ jobId: 'jb2', job: { id: 'jb2', title: 'late', state: 'executing', source: 'manual', createdAt: 3, updatedAt: 3, events: [], steps: [], live: NO_LIVE } });
    unmount();
    await flush();
    expect(mount.querySelectorAll('.ckb-item').length).toBe(0);
  });

  it('an unrelated repaint forces no layout and leaves the tally alone', async () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const unmount = renderDetail(mount);
    await flush();
    const tallyChild = mount.querySelector('.ckb-tally')!.firstChild;
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect');
    work.applyWsEvent({ jobId: 'jb', job: { ...work.get().byId.get('jb'), updatedAt: 99 } });
    await flush();
    expect(spy).not.toHaveBeenCalled();
    expect(mount.querySelector('.ckb-tally')!.firstChild).toBe(tallyChild);
    spy.mockRestore();
    unmount();
  });
});
