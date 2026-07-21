// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { usage } from '../../src/pwa/state/usage.js';

beforeEach(() => {
  usage.setStatusline(null);
  usage.setLastUsage(null);
  usage.setAccountUsage(null);
  usage.setContextWindow(200_000);
  usage.setProjectContextWindow(null);
});

describe('usage store', () => {
  it('setStatuslineFor caches per session', () => {
    usage.setStatuslineFor('s1', { model: 'opus-4' } as any);
    expect((usage.get().statuslineBySession.get('s1') as any).model).toBe('opus-4');
  });

  it('setContextWindow updates the cap', () => {
    usage.setContextWindow(1_000_000);
    expect(usage.get().contextWindow).toBe(1_000_000);
  });
});
