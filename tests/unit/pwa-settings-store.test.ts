// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { settings, VALID_THEMES, VALID_MODES } from '../../src/pwa/state/settings.js';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-mode');
});

describe('settings store', () => {
  it('setTheme writes-through to localStorage and html attribute', () => {
    settings.setTheme('almanac');
    expect(localStorage.getItem('cr:theme')).toBe('almanac');
    expect(document.documentElement.getAttribute('data-theme')).toBe('almanac');
    expect(settings.get().theme).toBe('almanac');
  });

  it('setTheme rejects unknown values', () => {
    settings.setTheme('not-a-theme' as any);
    expect(settings.get().theme).not.toBe('not-a-theme');
  });

  it('setMode persists and applies', () => {
    settings.setMode('light');
    expect(localStorage.getItem('cr:mode')).toBe('light');
    expect(document.documentElement.getAttribute('data-mode')).toBe('light');
  });

  it('setDefaultApprovalMode persists', () => {
    settings.setDefaultApprovalMode('plan');
    expect(localStorage.getItem('cr:defaultApprovalMode')).toBe('plan');
    expect(settings.get().defaultApprovalMode).toBe('plan');
  });

  it('VALID_THEMES has 9 entries', () => {
    expect(VALID_THEMES).toHaveLength(9);
  });

  it('VALID_MODES is [light, dark]', () => {
    expect(VALID_MODES).toEqual(['light', 'dark']);
  });

  it('setTheme pushes to the daemon (debounced PATCH includes theme)', async () => {
    const { vi } = await import('vitest');
    const patch = vi.fn();
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_u: string, opts: any) => {
      patch(JSON.parse(opts.body));
      return { ok: true, json: async () => ({}) };
    }));
    settings.setTheme('almanac');
    await vi.advanceTimersByTimeAsync(500);
    expect(patch).toHaveBeenCalledWith(expect.objectContaining({ theme: 'almanac' }));
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('setTheme with an invalid value never reaches the daemon — PATCH carries the last-good theme', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    const patch = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (_u: string, opts: any) => {
      patch(JSON.parse(opts.body));
      return { ok: true, json: async () => ({}) };
    }));

    settings.setTheme('almanac');
    await vi.advanceTimersByTimeAsync(500);
    patch.mockClear();

    settings.setTheme('not-a-theme' as any);
    await vi.advanceTimersByTimeAsync(500);

    expect(patch).toHaveBeenCalledWith(expect.objectContaining({ theme: 'almanac' }));
    expect(patch).not.toHaveBeenCalledWith(expect.objectContaining({ theme: 'not-a-theme' }));
    expect(settings.get().theme).toBe('almanac');

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
