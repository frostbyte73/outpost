// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The module caches the parsed map on first read, so each case needs a fresh evaluation of it —
// clearing localStorage alone would leave the previous case's cache in place.
async function reimport() {
  vi.resetModules();
  // @ts-expect-error PWA modules are plain JS; tests import them at runtime.
  return import('../../src/pwa/state/thread-collapse.js');
}

async function freshStore() {
  localStorage.clear();
  return reimport();
}

describe('thread-collapse', () => {
  beforeEach(() => localStorage.clear());

  it('reports a thread nobody has folded as open', async () => {
    const { isThreadCollapsed } = await freshStore();
    expect(isThreadCollapsed('review:abc', 1000)).toBe(false);
  });

  it('keeps a thread folded while nothing has been said since', async () => {
    const { isThreadCollapsed, setThreadCollapsed } = await freshStore();
    setThreadCollapsed('review:abc', true, 2000);
    expect(isThreadCollapsed('review:abc', 1000)).toBe(true);
  });

  // The whole reason the stored value is a timestamp rather than a boolean.
  it('unfolds a thread that gained a message after it was folded', async () => {
    const { isThreadCollapsed, setThreadCollapsed } = await freshStore();
    setThreadCollapsed('review:abc', true, 2000);
    expect(isThreadCollapsed('review:abc', 3000)).toBe(false);
  });

  it('survives a reload', async () => {
    const first = await freshStore();
    first.setThreadCollapsed('review:abc', true, 2000);
    const reloaded = await reimport();
    expect(reloaded.isThreadCollapsed('review:abc', 1000)).toBe(true);
  });

  it('unfolding forgets the thread rather than recording a false', async () => {
    const { isThreadCollapsed, setThreadCollapsed } = await freshStore();
    setThreadCollapsed('review:abc', true, 2000);
    setThreadCollapsed('review:abc', false);
    expect(isThreadCollapsed('review:abc', 1000)).toBe(false);
    expect(JSON.parse(localStorage.getItem('op:collapsedThreads')!)).toEqual({});
  });

  // Entries accumulate across every PR forever, so the map is bounded by count — an OLD stamp
  // is the case worth keeping, which is why it isn't bounded by age.
  it('drops the oldest folds past the cap', async () => {
    const { isThreadCollapsed, setThreadCollapsed } = await freshStore();
    for (let i = 0; i < 1001; i++) setThreadCollapsed(`t${i}`, true, 1000 + i);
    const stored = JSON.parse(localStorage.getItem('op:collapsedThreads')!);
    expect(Object.keys(stored)).toHaveLength(1000);
    expect(isThreadCollapsed('t0', 0)).toBe(false);
    expect(isThreadCollapsed('t1000', 0)).toBe(true);
  });
});
