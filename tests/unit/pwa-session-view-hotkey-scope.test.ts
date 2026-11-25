// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { headerHotkeyInScope, mountSessionView } from '../../src/pwa/components/session-view/index.js';

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

describe('session chrome', () => {
  it('puts runtime on the mode row for every mount', () => {
    const Orig = globalThis.WebSocket;
    class StubSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      static CLOSED = 3;
      readyState = StubSocket.CONNECTING;
      onclose: (() => void) | null = null;
      close() { this.readyState = StubSocket.CLOSED; this.onclose?.(); }
      send() {}
    }
    globalThis.WebSocket = StubSocket as unknown as typeof WebSocket;
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const handle = mountSessionView(mount, 'sess-plain', {});
    try {
      expect(mount.querySelector('.sv-header .sv-runtime')).toBeNull();
      expect(mount.querySelector('.sv-toolbar')!.firstElementChild?.classList.contains('sv-runtime')).toBe(true);
      expect(mount.querySelector('.sv-toolbar .sv-mode-chip')).toBeTruthy();
    } finally {
      handle.unmount();
      mount.remove();
      globalThis.WebSocket = Orig;
    }
  });

  it('hides the session header and puts runtime and expand on the mode row', () => {
    const Orig = globalThis.WebSocket;
    class StubSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      static CLOSED = 3;
      readyState = StubSocket.CONNECTING;
      onclose: (() => void) | null = null;
      close() { this.readyState = StubSocket.CLOSED; this.onclose?.(); }
      send() {}
    }
    globalThis.WebSocket = StubSocket as unknown as typeof WebSocket;
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const handle = mountSessionView(mount, 'sess-cockpit', { cockpit: true, onMaximize() {} });
    try {
      expect(mount.classList.contains('sv-cockpit')).toBe(true);
      expect(mount.querySelector('.sv-toolbar')!.firstElementChild?.classList.contains('sv-runtime')).toBe(true);
      expect(mount.querySelector('.sv-toolbar .sv-mode-chip')).toBeTruthy();
      expect(mount.querySelector('.sv-toolbar .sv-expand')?.getAttribute('aria-label')).toBe('Open full view');
      expect(mount.querySelector('.sv-header .sv-runtime')).toBeNull();
      expect(mount.querySelector('.sv-header .sv-header-name')).toBeTruthy();
    } finally {
      handle.unmount();
      mount.remove();
      globalThis.WebSocket = Orig;
    }
  });
});
