// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
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
});
