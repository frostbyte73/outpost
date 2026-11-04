import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Coming back to the foreground calls forceReconnectAll. iOS has usually severed the socket
// while the app was backgrounded, so by then it is closed with a retry already scheduled — or
// CLOSED without its onclose ever firing. forceReconnectAll used to cancel that retry and only
// reconnect sockets that were still OPEN, which left the view on "Reconnecting…" for good, with
// retries zeroed so the failed/Retry banner never appeared either.

class FakeWs {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWs[] = [];
  readyState = FakeWs.CONNECTING;
  onmessage: ((e: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWs.instances.push(this); }
  send(): void {}
  open(): void { this.readyState = FakeWs.OPEN; this.onopen?.(); }
  close(): void { this.readyState = FakeWs.CLOSED; this.onclose?.(); }
  // What iOS does to a backgrounded socket: dead, and nobody told.
  sever(): void { this.readyState = FakeWs.CLOSED; }
}

describe('forceReconnectAll', () => {
  let mod: {
    openSessionWs: (id: string) => void;
    forceReconnectAll: () => void;
    sessionWsReadyState: (id: string) => number;
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    FakeWs.instances = [];
    const g = globalThis as { WebSocket?: unknown; location?: unknown };
    g.WebSocket = FakeWs;
    g.location = { protocol: 'https:', host: 'daemon.test' };
    vi.resetModules();
    // @ts-expect-error PWA modules are plain JS.
    mod = await import('../../src/pwa/components/session-view/session-ws.js');
  });
  afterEach(() => { vi.useRealTimers(); });

  it('reconnects a socket that closed while backgrounded, instead of cancelling its retry', () => {
    mod.openSessionWs('s1');
    FakeWs.instances[0]!.open();
    FakeWs.instances[0]!.close(); // onclose fired; a retry is now pending
    mod.forceReconnectAll();
    expect(FakeWs.instances).toHaveLength(2);
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.instances).toHaveLength(2); // the cancelled retry doesn't also fire
  });

  it('reconnects a socket iOS severed without firing onclose', () => {
    mod.openSessionWs('s1');
    FakeWs.instances[0]!.open();
    FakeWs.instances[0]!.sever();
    mod.forceReconnectAll();
    expect(FakeWs.instances).toHaveLength(2);
    FakeWs.instances[1]!.open();
    expect(mod.sessionWsReadyState('s1')).toBe(FakeWs.OPEN);
  });

  it('ignores a late close from the socket it replaced', () => {
    mod.openSessionWs('s1');
    const stale = FakeWs.instances[0]!;
    stale.open();
    stale.sever();
    mod.forceReconnectAll();
    FakeWs.instances[1]!.open();
    stale.onclose?.(); // iOS finally delivers it
    expect(mod.sessionWsReadyState('s1')).toBe(FakeWs.OPEN);
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.instances).toHaveLength(2);
  });

  it('still cycles an open socket through close-and-retry', () => {
    mod.openSessionWs('s1');
    FakeWs.instances[0]!.open();
    mod.forceReconnectAll();
    vi.advanceTimersByTime(1_000);
    expect(FakeWs.instances).toHaveLength(2);
  });
});
