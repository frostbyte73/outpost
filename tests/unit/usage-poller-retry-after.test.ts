import { describe, it, expect } from 'vitest';
import { parseRetryAfter } from '../../src/integrations/usage-poller.js';

describe('parseRetryAfter', () => {
  it('returns null for a missing or unparseable header', () => {
    expect(parseRetryAfter(null)).toBe(null);
    expect(parseRetryAfter('')).toBe(null);
    expect(parseRetryAfter('soon')).toBe(null);
  });

  it('parses a delta-seconds value', () => {
    expect(parseRetryAfter('120')).toBe(120);
  });

  it('clamps to the 30s floor and 1h ceiling', () => {
    expect(parseRetryAfter('5')).toBe(30);
    expect(parseRetryAfter('99999')).toBe(3600);
  });

  it('parses an HTTP-date into seconds from now', () => {
    const future = new Date(Date.now() + 200_000).toUTCString();
    const secs = parseRetryAfter(future);
    expect(secs).toBeGreaterThanOrEqual(30);
    // ~200s out, allowing for ceil + test execution slop.
    expect(secs).toBeLessThanOrEqual(210);
    expect(secs).toBeGreaterThan(150);
  });

  it('clamps a past HTTP-date up to the floor rather than going negative', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter(past)).toBe(30);
  });
});
