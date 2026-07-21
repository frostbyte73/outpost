// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { isDesktop, isMobile, getLayout } from '../../src/pwa/layout/index.js';

beforeEach(() => {
  const mockMatchMedia = vi.fn().mockImplementation((q) => ({
    matches: false,
    media: q,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {},
    dispatchEvent: () => false, onchange: null,
  }));
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: mockMatchMedia,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete document.documentElement.dataset.layout;
});

describe('layout state', () => {
  it('reports desktop when dataset.layout=desktop', () => {
    document.documentElement.dataset.layout = 'desktop';
    expect(isDesktop()).toBe(true);
    expect(isMobile()).toBe(false);
    expect(getLayout()).toBe('desktop');
  });

  it('reports mobile when dataset.layout=mobile', () => {
    document.documentElement.dataset.layout = 'mobile';
    expect(isDesktop()).toBe(false);
    expect(isMobile()).toBe(true);
    expect(getLayout()).toBe('mobile');
  });

  it('defaults to mobile when dataset.layout is unset', () => {
    expect(isDesktop()).toBe(false);
    expect(getLayout()).toBe('mobile');
  });
});
