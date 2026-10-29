import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { createSeenReporter } from '../../src/pwa/components/session-view/seen.js';

function setup({ visible = true, entry = { lastReplyAt: 100, seenAt: 200 } } = {}) {
  const state = { visible, entry };
  let resolvePost: (seenAt: number) => void = () => {};
  let rejectPost: () => void = () => {};
  const postSeen = vi.fn(() => new Promise<number>((res, rej) => { resolvePost = res; rejectPost = () => rej(new Error('down')); }));
  const applySeen = vi.fn((_id: string, seenAt: number) => { state.entry = { ...state.entry, seenAt }; });
  const reporter = createSeenReporter({
    sessionId: 's1',
    isVisible: () => state.visible,
    activityFor: () => state.entry,
    postSeen,
    applySeen,
  });
  return { state, postSeen, applySeen, reporter, settle: (seenAt = 250) => resolvePost(seenAt), fail: () => rejectPost() };
}

describe('createSeenReporter', () => {
  it('posts when it gains visibility', () => {
    const { reporter, postSeen } = setup();
    reporter.onVisible();
    expect(postSeen).toHaveBeenCalledWith('s1');
  });

  it('does not post while hidden', () => {
    const { reporter, postSeen } = setup({ visible: false, entry: { lastReplyAt: 300, seenAt: 200 } });
    reporter.onVisible();
    reporter.onActivity();
    expect(postSeen).not.toHaveBeenCalled();
  });

  it('posts again when a reply lands past seenAt while visible', async () => {
    const { reporter, postSeen, state, settle } = setup();
    reporter.onVisible();
    settle();
    await new Promise((r) => setTimeout(r, 0));
    reporter.onActivity();
    expect(postSeen).toHaveBeenCalledTimes(1);
    state.entry = { lastReplyAt: 300, seenAt: 200 };
    reporter.onActivity();
    expect(postSeen).toHaveBeenCalledTimes(2);
  });

  it('does not re-post while a post is in flight', () => {
    const { reporter, postSeen, state } = setup({ entry: { lastReplyAt: 300, seenAt: 200 } });
    reporter.onVisible();
    state.entry = { lastReplyAt: 400, seenAt: 200 };
    reporter.onActivity();
    expect(postSeen).toHaveBeenCalledTimes(1);
  });

  it('applies the seenAt the daemon returns, so it does not post again', async () => {
    const { reporter, postSeen, applySeen, settle } = setup({ entry: { lastReplyAt: 300, seenAt: 200 } });
    reporter.onVisible();
    settle(350);
    await new Promise((r) => setTimeout(r, 0));
    expect(applySeen).toHaveBeenCalledWith('s1', 350);
    expect(postSeen).toHaveBeenCalledTimes(1);
  });

  it('does not re-post after a failed post', async () => {
    const { reporter, postSeen, fail } = setup({ entry: { lastReplyAt: 300, seenAt: 200 } });
    reporter.onVisible();
    fail();
    await new Promise((r) => setTimeout(r, 0));
    expect(postSeen).toHaveBeenCalledTimes(1);
  });
});
