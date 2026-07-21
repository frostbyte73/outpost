// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('nav store — density migration', () => {
  it('migrates density out of the legacy per-host nav blob into cr:density on first load', async () => {
    localStorage.setItem('outpost:nav:v1', JSON.stringify({
      localhost: {
        surface: 'cockpit',
        selectionBySurface: {},
        listWidth: 280,
        contextCollapsed: false,
        sidebarCollapsed: false,
        density: 'compact',
      },
    }));

    // @ts-expect-error PWA modules are plain JS; imported at runtime.
    const { nav } = await import('../../src/pwa/state/nav.js');

    expect(nav.get().density).toBe('compact');
    expect(localStorage.getItem('cr:density')).toBe('compact');
  });

  it('migrates density out of the pre-redesign legacy workspace blob when neither cr:density nor outpost:nav:v1 exist', async () => {
    localStorage.setItem('outpost:workspace:v1', JSON.stringify({
      localhost: {
        activity: 'sessions',
        density: 'compact',
      },
    }));

    // @ts-expect-error PWA modules are plain JS; imported at runtime.
    const { nav } = await import('../../src/pwa/state/nav.js');

    expect(nav.get().density).toBe('compact');
    expect(localStorage.getItem('cr:density')).toBe('compact');
  });

  it('setDensity pushes to the daemon (debounced PATCH includes density)', async () => {
    // @ts-expect-error PWA modules are plain JS; imported at runtime.
    const { nav } = await import('../../src/pwa/state/nav.js');

    const patch = vi.fn();
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_u: string, opts: any) => {
      patch(JSON.parse(opts.body));
      return { ok: true, json: async () => ({}) };
    }));

    nav.setDensity('roomy');
    await vi.advanceTimersByTimeAsync(500);
    expect(patch).toHaveBeenCalledWith(expect.objectContaining({ density: 'roomy' }));

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
