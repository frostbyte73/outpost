// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';

document.documentElement.dataset.layout = 'desktop';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
const { nav } = await import('../../src/pwa/state/nav.js');
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
const { installHistory } = await import('../../src/pwa/components/shell/history.js');

const popped = (go: () => void) => new Promise<void>((r) => { window.addEventListener('popstate', () => r(), { once: true }); go(); });
const here = () => { const s = nav.get(); return [s.surface, s.selectionBySurface[s.surface] ?? null]; };

describe('desktop shell history', () => {
  beforeAll(() => { nav.select('cockpit', null); installHistory(); });

  it('walks back and forward through surface + selection changes', async () => {
    nav.select('tracked', 'j1');
    nav.setSelection('j2');
    nav.select('schedules', 's1');

    await popped(() => history.back());
    expect(here()).toEqual(['tracked', 'j2']);
    await popped(() => history.back());
    expect(here()).toEqual(['tracked', 'j1']);
    await popped(() => history.back());
    expect(here()).toEqual(['cockpit', null]);
    await popped(() => history.forward());
    expect(here()).toEqual(['tracked', 'j1']);
  });

  it('pushes nothing for a store change that keeps the page', () => {
    const before = history.length;
    nav.setListWidth(400);
    nav.toggleContextCollapsed();
    nav.select(...(here() as [string, string | null]));
    expect(history.length).toBe(before);
  });

  it('stands down on the mobile layout, which owns history there', () => {
    document.documentElement.dataset.layout = 'mobile';
    const before = history.length;
    nav.select('runs', 'r1');
    expect(history.length).toBe(before);
    document.documentElement.dataset.layout = 'desktop';
  });
});
