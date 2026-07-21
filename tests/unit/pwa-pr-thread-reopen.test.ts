// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { renderThreadCard } from '../../src/pwa/components/work/thread-card.js';

const comment = (over = {}) => ({
  id: 'c1', author: 'octocat', body: 'please rename this', file: 'a.ts', line: 3,
  createdAt: 1000, ...over,
});

// A resolved thread = a chain whose leaf carries respondedAt. The draft was
// dropped when the user resolved it, so pr-block hands renderThreadCard no draft.
const resolvedChain = [comment({ respondedAt: 2000 })];
const openChain = [comment()];
const step = (over = {}) => ({ id: 's1', state: 'reply_pending_review', ...over });

describe('renderThreadCard resolved threads', () => {
  it('offers an enabled Reopen action so the user can rerun a resolved comment', () => {
    const html = renderThreadCard(resolvedChain, undefined, step());
    expect(html).toContain('thread-action-reopen');
    // Reopen must be actionable — it reuses the regenerate handler.
    expect(html).toMatch(/thread-action-reopen[^>]*data-thread-action="regenerate"/);
    expect(html).not.toMatch(/thread-action-reopen[^>]*\bdisabled\b/);
  });

  it('does not show the "Claude is deciding" pending rationale on a resolved thread', () => {
    const html = renderThreadCard(resolvedChain, undefined, step());
    expect(html).not.toContain('Claude is deciding');
  });

  it('disables Reopen once the PR is merged (backend refuses to reopen)', () => {
    const html = renderThreadCard(resolvedChain, undefined, step({ prState: 'merged' }));
    expect(html).toMatch(/thread-action-reopen[^>]*\bdisabled\b/);
  });
});

describe('renderThreadCard open threads (regression)', () => {
  it('keeps Reply/Edit/Ignore enabled when a draft is present', () => {
    const draft = { commentId: 'c1', recommendation: 'reply', draftReply: 'ok', rationale: 'because' };
    const html = renderThreadCard(openChain, draft, step());
    expect(html).toMatch(/thread-action-reply[^>]*>Reply</);
    expect(html).not.toMatch(/thread-action-reply[^>]*\bdisabled\b/);
    expect(html).toContain('because');
  });

  it('shows the pending rationale and disabled actions before a draft exists', () => {
    const html = renderThreadCard(openChain, undefined, step());
    expect(html).toContain('Claude is deciding');
    expect(html).toMatch(/thread-action-reply[^>]*\bdisabled\b/);
  });
});
