// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

if (typeof CSS === 'undefined') (globalThis as any).CSS = { escape: (s: string) => s };
vi.mock('../../src/pwa/state/work.js', () => ({ work: { acceptDraft: vi.fn(), reviseDraft: vi.fn(), denyDraft: vi.fn(), setStepPreapprovals: vi.fn() } }));
vi.mock('../../src/pwa/app-bridge.js', () => ({ showStatusToast: vi.fn(), openSession: vi.fn() }));

// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
const { renderWriteDraft, renderAutoApprovedDraft } = await import('../../src/pwa/components/work/write-draft-card.js');

const call = { id: 'c1', label: 'push', bash: 'git push -u origin deps/x' };

describe('a draft that fell back to the user', () => {
  it('says why it was not auto-approved', () => {
    const html = renderWriteDraft({ id: 'd1', action: 'code.orchestrate-pr', summary: 'push', calls: [call], requestedAt: 1, autoApproveMiss: 'call 1: needs the push pre-approval' });
    expect(html).toContain('Not auto-approved');
    expect(html).toContain('needs the push pre-approval');
  });

  it('says nothing extra on an ordinary draft', () => {
    expect(renderWriteDraft({ id: 'd1', action: 'a', summary: 's', calls: [call], requestedAt: 1 })).not.toContain('Not auto-approved');
  });
});

describe('a draft the daemon approved', () => {
  it('renders as decided, with the calls that ran and no decision buttons', () => {
    const html = renderAutoApprovedDraft({ id: 'd1', action: 'code.orchestrate-pr', summary: 'Push deps/x', calls: [call], requestedAt: 1, approvedAt: 2, approvedBy: 'preapproval' });
    const el = document.createElement('div');
    el.innerHTML = html;
    expect(el.textContent).toContain('pre-approved');
    expect(el.textContent).toContain('git push -u origin deps/x');
    expect(el.querySelector('button')).toBeNull();
  });
});
