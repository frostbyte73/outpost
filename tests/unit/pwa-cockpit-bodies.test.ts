// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { mountBody } from '../../src/pwa/components/cockpit/bodies.js';
// @ts-expect-error runtime JS import
import { work } from '../../src/pwa/state/work.js';

const NO_LIVE = { orchestrator: false, stepIds: [], sessionIds: [], interactiveSessionIds: [] };

function seed(id: string, step: Record<string, unknown>, updatedAt = 1) {
  const job = {
    id, title: 'j', state: 'executing', source: 'manual', createdAt: 1, updatedAt, events: [], live: NO_LIVE,
    steps: [{ id: 's1', type: 'orchestrated', controller: 'code.orchestrate-pr', title: 'Fix', dispatches: [], drafts: [],
      createdAt: 1, updatedAt, sessionId: 'x', ...step }],
  };
  work.applyWsEvent({ jobId: id, job });
  return job;
}

const row = (id: string, actions: unknown[] = []) => ({ key: `job:${id}`, kind: 'job', id, actions });

describe('cockpit bodies survive job updates', () => {
  it('the caret body keeps a focused, half-typed controller message', () => {
    seed('jc', { state: 'waiting' });
    const el = document.createElement('div');
    document.body.appendChild(el);
    const body = mountBody(el, row('jc'), 'caret');
    const ta = el.querySelector<HTMLTextAreaElement>('[data-composer="orc-message"] textarea')!;
    ta.value = 'half a thought';
    ta.focus();

    seed('jc', { state: 'waiting', phase: 'implement' }, 2);
    body.update(row('jc'));

    expect(el.querySelector('[data-composer="orc-message"] textarea')).toBe(ta);
    expect(document.activeElement).toBe(ta);
    expect(ta.value).toBe('half a thought');
    body.unmount();
  });

  it('an unrelated approval elsewhere on the job does not rebuild the gate', () => {
    seed('jg', { state: 'gate_pending_approval', gate: { question: 'Ok?', draft: 'spec' } });
    const el = document.createElement('div');
    document.body.appendChild(el);
    const gate = { kind: 'gate', stepId: 's1', phase: 'spec', question: 'Ok?' };
    const body = mountBody(el, row('jg', [gate]), 'action');
    const ta = el.querySelector('[data-composer="orc-gate-feedback"] textarea');

    body.update(row('jg', [gate, { kind: 'approval', sessionId: 'x', approvalId: 'a1', toolName: 'Bash' }]));

    expect(el.querySelector('[data-composer="orc-gate-feedback"] textarea')).toBe(ta);
    body.unmount();
  });

  it('a rebuild for a new waiting item keeps typed text and focus in the gate', () => {
    seed('jr', { state: 'gate_pending_approval', gate: { question: 'Ok?', draft: 'spec' } });
    const el = document.createElement('div');
    document.body.appendChild(el);
    const gate = { kind: 'gate', stepId: 's1', phase: 'spec', question: 'Ok?' };
    const body = mountBody(el, row('jr', [gate]), 'action');
    el.querySelector('[data-orc-action="toggle-gate-feedback"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const ta = el.querySelector<HTMLTextAreaElement>('[data-composer="orc-gate-feedback"] textarea')!;
    ta.value = 'tighten scope';
    ta.focus();

    body.update(row('jr', [gate, { kind: 'stall', auth: false, error: 'rate_limit' }]));

    const after = el.querySelector<HTMLTextAreaElement>('[data-composer="orc-gate-feedback"] textarea')!;
    expect(after.value).toBe('tighten scope');
    expect(document.activeElement).toBe(after);
    body.unmount();
  });
});
