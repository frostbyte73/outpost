// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';

describe('localStorage', () => {
  it('works', () => {
    localStorage.setItem('foo', 'bar');
    expect(localStorage.getItem('foo')).toBe('bar');
    localStorage.clear();
    expect(localStorage.getItem('foo')).toBeNull();
  });
});
