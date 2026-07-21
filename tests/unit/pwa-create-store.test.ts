// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { createStore } from '../../src/pwa/state/create-store.js';

describe('createStore', () => {
  it('returns the initial state from get()', () => {
    const store = createStore({ count: 0 });
    expect(store.get()).toEqual({ count: 0 });
  });

  it('replaces state when set() is called with a new value', () => {
    const store = createStore({ count: 0 });
    store.set({ count: 1 });
    expect(store.get()).toEqual({ count: 1 });
  });

  it('supports updater function form', () => {
    const store = createStore({ count: 0 });
    store.set((s: { count: number }) => ({ count: s.count + 1 }));
    expect(store.get()).toEqual({ count: 1 });
  });

  it('notifies subscribers synchronously', () => {
    const store = createStore({ n: 0 });
    const fn = vi.fn();
    store.subscribe(fn);
    store.set({ n: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ n: 1 });
  });

  it('skips notification when set() returns identity-equal state', () => {
    const store = createStore({ n: 0 });
    const initial = store.get();
    const fn = vi.fn();
    store.subscribe(fn);
    store.set(initial);
    expect(fn).not.toHaveBeenCalled();
  });

  it('subscribe returns an unsubscribe', () => {
    const store = createStore({ n: 0 });
    const fn = vi.fn();
    const off = store.subscribe(fn);
    off();
    store.set({ n: 1 });
    expect(fn).not.toHaveBeenCalled();
  });

  it('multiple subscribers are notified in subscription order', () => {
    const store = createStore({ n: 0 });
    const calls: string[] = [];
    store.subscribe(() => calls.push('a'));
    store.subscribe(() => calls.push('b'));
    store.set({ n: 1 });
    expect(calls).toEqual(['a', 'b']);
  });
});
