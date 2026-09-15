import { describe, it, expect, vi } from 'vitest';
import { SessionManager } from '../../src/session/session-manager.js';

// Reloading live sessions after a credential is re-authorized. Closing is the whole mechanism —
// sendOrResume respawns with --resume on the next message — so what's worth pinning is WHICH
// sessions get closed: a session mid-turn must not, because killing it discards the in-flight
// turn and fails the step that owns it.

function managerWithSessions(ids: string[], working: string[] = []): {
  manager: SessionManager;
  kills: Map<string, ReturnType<typeof vi.fn>>;
} {
  const manager = new SessionManager({
    settingsPath: '/tmp/settings.json',
    mcpConfigPath: '/tmp/mcp.json',
    daemonAuthSecret: 's',
    daemonHost: '127.0.0.1',
    hookPort: 1,
    sessionStore: { findSession: () => undefined } as never,
  });
  const kills = new Map<string, ReturnType<typeof vi.fn>>();
  const internals = manager as unknown as {
    active: Map<string, unknown>;
    working: Map<string, number>;
  };
  for (const id of ids) {
    const kill = vi.fn(async () => {});
    kills.set(id, kill);
    internals.active.set(id, { id, proc: { kill }, clients: new Set(), registeredIds: new Set() });
  }
  for (const id of working) internals.working.set(id, Date.now());
  return { manager, kills };
}

describe('reloadForReauth', () => {
  it('closes idle sessions', () => {
    const { manager, kills } = managerWithSessions(['a', 'b']);
    const { closed, deferred } = manager.reloadForReauth();
    expect(closed.sort()).toEqual(['a', 'b']);
    expect(deferred).toEqual([]);
    expect(kills.get('a')).toHaveBeenCalled();
    expect(kills.get('b')).toHaveBeenCalled();
  });

  it('leaves a session mid-turn alone and closes it when its turn ends', () => {
    const { manager, kills } = managerWithSessions(['idle', 'busy'], ['busy']);

    const { closed, deferred } = manager.reloadForReauth();
    expect(closed).toEqual(['idle']);
    expect(deferred).toEqual(['busy']);
    expect(kills.get('busy')).not.toHaveBeenCalled();

    manager.markTurnEnded('busy');
    expect(kills.get('busy')).toHaveBeenCalled();
  });

  // The deferral is armed by a re-auth, not by every turn — a session that merely finishes a
  // turn afterwards must not be torn down under the user.
  it('does not close a session whose turn ends without a pending reload', () => {
    const { manager, kills } = managerWithSessions(['a'], ['a']);
    manager.markTurnEnded('a');
    expect(kills.get('a')).not.toHaveBeenCalled();
  });
});
