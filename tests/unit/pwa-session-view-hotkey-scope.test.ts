// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { headerHotkeyInScope } from '../../src/pwa/components/session-view/index.js';

describe('headerHotkeyInScope', () => {
  it('an unscoped view always answers (the Sessions surface has one view)', () => {
    expect(headerHotkeyInScope(document.createElement('div'), false)).toBe(true);
  });

  it('a scoped view answers only while focus is inside it', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    const input = document.createElement('textarea');
    a.appendChild(input);
    document.body.append(a, b);
    input.focus();
    expect(headerHotkeyInScope(a, true)).toBe(true);
    expect(headerHotkeyInScope(b, true)).toBe(false);
  });
});
