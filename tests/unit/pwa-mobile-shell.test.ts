import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { tabForSurface, PRIMARY_SURFACES, MORE_SURFACES } from '../../src/pwa/components/mobile-shell/tabs.js';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { initMoreAtRoot, computeMoreDeepLink, resolveMoreScreen } from '../../src/pwa/components/mobile-shell/more-state.js';

describe('tabForSurface', () => {
  it('maps primary surfaces to themselves', () => {
    for (const s of PRIMARY_SURFACES) expect(tabForSurface(s)).toBe(s);
  });

  it('maps More-owned surfaces to the more tab', () => {
    for (const s of MORE_SURFACES) expect(tabForSurface(s)).toBe('more');
  });

  it('falls back to cockpit for an unrecognized surface', () => {
    expect(tabForSurface('nonsense')).toBe('cockpit');
  });
});

describe('initMoreAtRoot', () => {
  it('starts drilled-in when the boot surface is a More-owned surface (deep link)', () => {
    expect(initMoreAtRoot('settings', MORE_SURFACES)).toBe(false);
  });

  it('starts at root when the boot surface is a primary tab', () => {
    expect(initMoreAtRoot('cockpit', MORE_SURFACES)).toBe(true);
  });
});

describe('computeMoreDeepLink', () => {
  const base = { moreAtRoot: true, lastMoreDeepLinkKey: null };

  it('leaves state untouched when the current surface is not More-owned', () => {
    const next = computeMoreDeepLink(base, { surface: 'cockpit', selectionBySurface: {} }, MORE_SURFACES);
    expect(next).toEqual({ moreAtRoot: true, lastMoreDeepLinkKey: null });
  });

  it('leaves state untouched when a More surface has no selection', () => {
    const next = computeMoreDeepLink(base, { surface: 'settings', selectionBySurface: {} }, MORE_SURFACES);
    expect(next).toBe(base);
  });

  it('drills in on a fresh selection arriving for a More surface', () => {
    const next = computeMoreDeepLink(base, { surface: 'settings', selectionBySurface: { settings: 'general' } }, MORE_SURFACES);
    expect(next).toEqual({ moreAtRoot: false, lastMoreDeepLinkKey: 'settings:general' });
  });

  it('does not re-drill on the same selection once already applied', () => {
    const drilled = { moreAtRoot: false, lastMoreDeepLinkKey: 'settings:general' };
    const next = computeMoreDeepLink(drilled, { surface: 'settings', selectionBySurface: { settings: 'general' } }, MORE_SURFACES);
    expect(next).toBe(drilled);
  });

  it('does not re-drill after the user deliberately backs out to root with the same selection still set', () => {
    const backedOut = { moreAtRoot: true, lastMoreDeepLinkKey: 'settings:general' };
    const next = computeMoreDeepLink(backedOut, { surface: 'settings', selectionBySurface: { settings: 'general' } }, MORE_SURFACES);
    expect(next).toBe(backedOut);
  });

  it('re-drills when a different selection arrives for the same surface', () => {
    const drilled = { moreAtRoot: false, lastMoreDeepLinkKey: 'settings:general' };
    const next = computeMoreDeepLink(drilled, { surface: 'settings', selectionBySurface: { settings: 'appearance' } }, MORE_SURFACES);
    expect(next).toEqual({ moreAtRoot: false, lastMoreDeepLinkKey: 'settings:appearance' });
  });

  it('clears the dedup key once navigation leaves More-owned surfaces entirely', () => {
    const drilled = { moreAtRoot: false, lastMoreDeepLinkKey: 'settings:general' };
    const next = computeMoreDeepLink(drilled, { surface: 'cockpit', selectionBySurface: {} }, MORE_SURFACES);
    expect(next).toEqual({ moreAtRoot: false, lastMoreDeepLinkKey: null });
  });
});

describe('resolveMoreScreen', () => {
  it('shows the root menu when at root, regardless of the underlying nav surface', () => {
    expect(resolveMoreScreen(true, 'skills')).toEqual({ screen: 'more-root', nextMoreAtRoot: true });
  });

  it('drills into a known More surface', () => {
    expect(resolveMoreScreen(false, 'skills')).toEqual({ screen: 'skills', nextMoreAtRoot: false });
    expect(resolveMoreScreen(false, 'settings')).toEqual({ screen: 'settings', nextMoreAtRoot: false });
    expect(resolveMoreScreen(false, 'runs')).toEqual({ screen: 'runs', nextMoreAtRoot: false });
  });

  it('falls back to root for an unrecognized surface instead of a blank screen', () => {
    expect(resolveMoreScreen(false, 'cockpit')).toEqual({ screen: 'more-root', nextMoreAtRoot: true });
  });
});
