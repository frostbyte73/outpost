// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

beforeEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.resetModules(); });
afterEach(() => { vi.useRealTimers(); });

describe('preferences sync layer', () => {
  it('hydrate applies daemon values (daemon wins) and does not seed present keys', async () => {
    // @ts-expect-error PWA modules are plain JS; tests import them at runtime.
    const { register, hydrate } = await import('../../src/pwa/state/preferences.js');
    const applied: string[] = [];
    register({ key: 'theme', apply: (v: string) => applied.push(v), current: () => 'halcyon' });
    const patch = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, opts?: any) => {
      if (!opts) return { ok: true, json: async () => ({ theme: 'ink' }) };
      patch(JSON.parse(opts.body));
      return { ok: true, json: async () => ({}) };
    }));
    await hydrate();
    expect(applied).toEqual(['ink']);
    expect(patch).not.toHaveBeenCalled();
  });

  it('hydrate seeds the daemon from current() for keys the daemon lacks', async () => {
    // @ts-expect-error PWA modules are plain JS; tests import them at runtime.
    const { register, hydrate } = await import('../../src/pwa/state/preferences.js');
    register({ key: 'mode', apply: () => {}, current: () => 'light' });
    const patch = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, opts?: any) => {
      if (!opts) return { ok: true, json: async () => ({}) }; // daemon empty
      patch(JSON.parse(opts.body));
      return { ok: true, json: async () => ({}) };
    }));
    await hydrate();
    // seed PATCH includes exactly the registered key's current value (fresh registry per test)
    expect(patch).toHaveBeenCalledWith({ mode: 'light' });
  });

  it('hydrate keeps local mirror on daemon fetch failure (no throw)', async () => {
    // @ts-expect-error PWA modules are plain JS; tests import them at runtime.
    const { register, hydrate } = await import('../../src/pwa/state/preferences.js');
    register({ key: 'theme', apply: () => { throw new Error('should not apply'); }, current: () => 'x' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(hydrate()).resolves.toBeUndefined();
  });

  it('push debounces multiple changes into one PATCH', async () => {
    // @ts-expect-error PWA modules are plain JS; tests import them at runtime.
    const { push } = await import('../../src/pwa/state/preferences.js');
    vi.useFakeTimers();
    const patch = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: any) => {
      patch(JSON.parse(opts.body));
      return { ok: true, json: async () => ({}) };
    }));
    push('theme', 'ink');
    push('mode', 'dark');
    push('theme', 'almanac'); // last write wins for the key
    expect(patch).not.toHaveBeenCalled(); // still within debounce window
    await vi.advanceTimersByTimeAsync(500);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith({ theme: 'almanac', mode: 'dark' });
  });
});
