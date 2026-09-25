import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../../src/session/session-manager.js';

// An attach the daemon refuses is a verdict on the URL, not a dropped socket: re-sending the
// identical query is refused identically. The client reconnects on an ordinary close, so the
// two halves pinned here are what stop that becoming an unbounded loop — a job whose
// orchestrator transcript had aged out of ~/.claude/projects reconnected every 750ms for as
// long as its detail view stayed open, appending an error line each pass.

function attachAndCapture(opts: { cwd?: string; spawnMode?: 'shared' | 'worktree'; baseBranch?: string }) {
  const manager = new SessionManager({
    settingsPath: '/tmp/settings.json',
    mcpConfigPath: '/tmp/mcp.json',
    daemonAuthSecret: 's',
    daemonHost: '127.0.0.1',
    hookPort: 1,
    sessionStore: { findSession: () => null } as never,
  });
  const sent: Record<string, unknown>[] = [];
  const close = vi.fn();
  const ws = { send: (raw: string) => sent.push(JSON.parse(raw)), close } as never;
  manager.attach('dead-session', ws, opts);
  return { sent, close };
}

describe('SessionManager.attach rejections', () => {
  // The case behind the loop: the session predates Claude Code's transcript retention, so
  // findSession can no longer resolve a cwd and the client had none to offer.
  it('marks an unresolvable session fatal and closes', () => {
    const { sent, close } = attachAndCapture({});
    expect(sent).toEqual([
      { type: 'daemon_error', fatal: true, message: 'cwd required for new session' },
    ]);
    expect(close).toHaveBeenCalled();
  });

  it.each([
    ['relative cwd', { cwd: 'relative/path' }],
    ['missing cwd', { cwd: '/nonexistent/path/outpost-test' }],
    ['worktree spawn with no base branch', { cwd: '/tmp', spawnMode: 'worktree' as const }],
  ])('marks %s fatal and closes', (_label, opts) => {
    const { sent, close } = attachAndCapture(opts);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'daemon_error', fatal: true });
    expect(close).toHaveBeenCalled();
  });
});

class FakeWs {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWs[] = [];
  readyState = FakeWs.OPEN;
  onmessage: ((e: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWs.instances.push(this); }
  send(): void {}
  close(): void { this.readyState = FakeWs.CLOSED; this.onclose?.(); }
  // The daemon accepts the upgrade before attach() runs, so `onopen` fires on every pass —
  // which is why the loop never backed off past its base delay.
  refuse(frame: Record<string, unknown>): void {
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify(frame) });
    this.close();
  }
}

describe('session-ws reconnect', () => {
  let openSessionWs: (id: string, spawn?: unknown) => void;

  beforeEach(async () => {
    vi.useFakeTimers();
    FakeWs.instances = [];
    const g = globalThis as { WebSocket?: unknown; location?: unknown };
    g.WebSocket = FakeWs;
    g.location = { protocol: 'https:', host: 'daemon.test' };
    vi.resetModules();
    // @ts-expect-error PWA modules are plain JS.
    ({ openSessionWs } = await import('../../src/pwa/components/session-view/session-ws.js'));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('stops reconnecting once the daemon refuses the attach', () => {
    openSessionWs('dead-session');
    expect(FakeWs.instances).toHaveLength(1);
    FakeWs.instances[0]!.refuse({ type: 'daemon_error', fatal: true, message: 'cwd required for new session' });
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.instances).toHaveLength(1);
  });

  // A mid-session error (subprocess stderr, a throwing frame handler) leaves the socket usable
  // and must keep the ordinary backoff — otherwise this guard silently kills live reconnects.
  it('still reconnects after a non-fatal daemon error', () => {
    openSessionWs('live-session');
    FakeWs.instances[0]!.refuse({ type: 'daemon_error', message: 'claude wrote to stderr' });
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.instances.length).toBeGreaterThan(1);
  });
});
