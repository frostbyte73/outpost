// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { renderPreapprovalsControl, readPreapprovalsControl, wirePreapprovalsControl } from '../../src/pwa/components/work/preapprovals-control.js';

function mount(value: unknown, opts: Record<string, unknown> = {}) {
  const root = document.createElement('div');
  root.innerHTML = renderPreapprovalsControl(value, { name: 's1', ...opts });
  wirePreapprovalsControl(root);
  return root.querySelector('fieldset')! as HTMLFieldSetElement;
}

describe('the pre-approvals control', () => {
  it('reads back exactly what it rendered', () => {
    const value = { spec: 'auto', push: true, openPr: false, replies: true, merge: false, landing: 'approved' };
    expect(readPreapprovalsControl(mount(value))).toEqual(value);
  });

  it('renders an absent value as fully gated', () => {
    expect(readPreapprovalsControl(mount(undefined))).toEqual({
      spec: 'gate', push: false, openPr: false, replies: false, merge: false, landing: 'merged',
    });
  });

  it('fills every field from a picked preset', () => {
    const fs = mount(undefined);
    const preset = fs.querySelector<HTMLSelectElement>('[data-pre="preset"]')!;
    preset.value = 'routine';
    preset.dispatchEvent(new Event('change', { bubbles: true }));
    expect(readPreapprovalsControl(fs)).toMatchObject({ spec: 'skip', push: true, openPr: true, landing: 'approved' });
  });

  it('shows custom once a field departs from the preset', () => {
    const fs = mount({ spec: 'skip', push: true, openPr: true, replies: true, merge: false, landing: 'approved' });
    const merge = fs.querySelector<HTMLInputElement>('[data-pre="merge"]')!;
    merge.checked = true;
    merge.dispatchEvent(new Event('change', { bubbles: true }));
    expect(fs.querySelector<HTMLSelectElement>('[data-pre="preset"]')!.value).toBe('custom');
  });

  it('marks fields the planner loosened', () => {
    const fs = mount({ merge: true }, { loosened: ['merge'] });
    expect(fs.querySelector('[data-pre="merge"]')!.closest('label')!.getAttribute('data-loosened')).toBe('true');
  });
});

describe('edits across a repaint', () => {
  it('survive the markup being replaced, until the scope is cleared', async () => {
    // @ts-expect-error PWA modules are plain JS; tests import them at runtime.
    const { clearPreapprovalsScope } = await import('../../src/pwa/components/work/preapprovals-control.js');
    const root = document.createElement('div');
    const paint = () => {
      root.innerHTML = renderPreapprovalsControl(undefined, { name: 's1' });
      wirePreapprovalsControl(root, 'job-1');
      return root.querySelector('fieldset')! as HTMLFieldSetElement;
    };
    const push = paint().querySelector<HTMLInputElement>('[data-pre="push"]')!;
    push.checked = true;
    push.dispatchEvent(new Event('change', { bubbles: true }));

    expect(readPreapprovalsControl(paint()).push).toBe(true);
    clearPreapprovalsScope('job-1');
    expect(readPreapprovalsControl(paint()).push).toBe(false);
  });
});

describe('collecting plan-review values', () => {
  it('reads only the plan card, never a running step card that shares the step id', async () => {
    // @ts-expect-error PWA modules are plain JS; tests import them at runtime.
    const { collectPlanPreapprovals, wirePlanPreapprovals } = await import('../../src/pwa/components/work/plan-section.js');
    const root = document.createElement('div');
    root.innerHTML = `
      <section class="plan-section">
        <div class="plan-card">${renderPreapprovalsControl({ push: true }, { name: 's1' })}</div>
        <div class="orc-card">${renderPreapprovalsControl({ merge: true }, { name: 's1' })}</div>
      </section>`;
    wirePlanPreapprovals(root, 'plan:j9');
    expect(collectPlanPreapprovals(root)).toEqual({ s1: expect.objectContaining({ push: true, merge: false }) });
  });
});

describe('the schedule card', () => {
  it('forgets an edit the user cancelled', async () => {
    // @ts-expect-error PWA modules are plain JS; tests import them at runtime.
    const { renderPreapprovalsCard } = await import('../../src/pwa/components/schedules/preapprovals-card.js');
    const schedule = { id: 'sch-1', preapprovals: { push: true } };
    const editState: Record<string, boolean> = { preapprovals: true };
    const host = document.createElement('div');
    const repaint = () => { host.replaceChildren(renderPreapprovalsCard(schedule, editState, repaint, async () => {})); };
    repaint();
    const merge = host.querySelector<HTMLInputElement>('[data-pre="merge"]')!;
    merge.checked = true;
    merge.dispatchEvent(new Event('change', { bubbles: true }));
    host.querySelector<HTMLButtonElement>('.sched-cancel')!.click();

    editState.preapprovals = true;
    repaint();
    expect(host.querySelector<HTMLInputElement>('[data-pre="merge"]')!.checked).toBe(false);
  });
});
