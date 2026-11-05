import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../../src/session/session-manager.js';
import { RuntimeRegistry } from '../../src/runtime/registry.js';
import type { AgentRuntime, CanonicalEvent, StartCallbacks, StartOpts } from '../../src/runtime/types.js';

interface FakeSession { sessionId: string; cwd: string; onEvent: (e: CanonicalEvent) => void; onExit: (code: number | null) => void }
const procs: FakeSession[] = [];

const runtime = {
  start(opts: StartOpts, cb: StartCallbacks) {
    const p = { sessionId: opts.sessionId, cwd: opts.cwd, onEvent: cb.onEvent, onExit: cb.onExit };
    procs.push(p);
    return { sendTurn() {}, interrupt() {}, async kill() { await Promise.resolve(); p.onExit(143); } };
  },
} as unknown as AgentRuntime;

const IDLE_MS = 15 * 60 * 1000;

function fakeWs() {
  const sent: Record<string, unknown>[] = [];
  const handlers = new Map<string, () => void>();
  const ws = {
    send: (raw: string) => sent.push(JSON.parse(raw)),
    close: vi.fn(),
    on: (ev: string, fn: () => void) => handlers.set(ev, fn),
  };
  return { ws: ws as never, sent, close: ws.close, fireClose: () => handlers.get('close')?.() };
}

function newManager(opts: { known?: boolean; hasPendingApproval?: (id: string) => boolean } = {}) {
  const onWorkingChange = vi.fn();
  const onAssistantReply = vi.fn();
  const manager = new SessionManager({
    runtimes: new RuntimeRegistry(runtime),
    sessionStore: {
      findSession: () => (opts.known ? { cwd: '/tmp' } : undefined),
      readSpawnEnv: () => undefined,
      writeSpawnEnv: () => {},
      readSystemPrompt: () => undefined,
      readRuntime: () => null,
    } as never,
    hasPendingApproval: opts.hasPendingApproval,
    onWorkingChange,
    onAssistantReply,
  });
  return { manager, onWorkingChange, onAssistantReply };
}

const reply: CanonicalEvent = { type: 'item.completed', item: { type: 'assistant_message', id: 'a0', text: 'hi' } };
const isReply = (m: Record<string, unknown>) => m.type === 'item.completed';

describe('watch-only attach', () => {
  beforeEach(() => { procs.length = 0; });

  it('attach to a session with no process spawns nothing and reports it not working', () => {
    const { manager } = newManager({ known: true });
    const a = fakeWs();
    manager.attach('s1', a.ws, {});
    expect(procs).toHaveLength(0);
    expect(manager.isActive('s1')).toBe(false);
    expect(a.sent[0]).toMatchObject({ type: 'session_state', working: false });
  });

  it('session_state says whether a process is behind the socket', async () => {
    const { manager } = newManager({ known: true });
    const a = fakeWs();
    manager.attach('s1', a.ws, {});
    await manager.wake('s1');
    expect(a.sent.filter((m) => m.type === 'session_state').map((m) => m.live)).toEqual([false, true]);
  });

  it('wake promotes every watcher', async () => {
    const { manager } = newManager({ known: true });
    const a = fakeWs();
    const b = fakeWs();
    manager.attach('s1', a.ws, {});
    manager.attach('s1', b.ws, {});
    await manager.wake('s1');
    expect(procs).toHaveLength(1);
    procs[0]!.onEvent(reply);
    expect(a.sent.some(isReply)).toBe(true);
    expect(b.sent.some(isReply)).toBe(true);
  });

  it('wake spawns a new session from the hints stashed at attach', async () => {
    const { manager } = newManager();
    manager.attach('fresh', fakeWs().ws, { cwd: '/tmp' });
    expect(procs).toHaveLength(0);
    await manager.wake('fresh');
    expect(procs[0]).toMatchObject({ sessionId: 'fresh', cwd: '/tmp' });
  });

  it('wake respawns an exited session in its last cwd even without a transcript', async () => {
    const { manager } = newManager();
    const a = fakeWs();
    manager.attach('fresh', a.ws, { cwd: '/tmp' });
    await manager.wake('fresh');
    procs[0]!.onExit(0);
    await manager.wake('fresh');
    expect(procs).toHaveLength(2);
    expect(procs[1]).toMatchObject({ sessionId: 'fresh', cwd: '/tmp' });
  });

  it('broadcast reaches the watchers of a session with no process', () => {
    const { manager } = newManager({ known: true });
    const a = fakeWs();
    manager.attach('s1', a.ws, {});
    manager.broadcast('s1', { type: 'approval_mode', sessionId: 's1', mode: 'plan' });
    expect(a.sent.at(-1)).toEqual({ type: 'approval_mode', sessionId: 's1', mode: 'plan' });
  });

  it('forgets a new session\'s hints once nobody is watching it', async () => {
    const { manager } = newManager();
    const a = fakeWs();
    manager.attach('fresh', a.ws, { cwd: '/tmp' });
    a.fireClose();
    await expect(manager.wake('fresh')).rejects.toThrow();
  });

  it('wake rejects when nothing can be spawned', async () => {
    const { manager } = newManager();
    await expect(manager.wake('ghost')).rejects.toThrow();
  });

  it('close demotes clients to watchers without closing them', async () => {
    const { manager } = newManager({ known: true });
    const a = fakeWs();
    manager.attach('s1', a.ws, {});
    await manager.wake('s1');
    await manager.close('s1', 'idle');
    expect(a.close).not.toHaveBeenCalled();
    expect(a.sent.some((m) => m.type === 'daemon_proc_exit')).toBe(true);
    await manager.wake('s1');
    procs[1]!.onEvent(reply);
    expect(a.sent.filter(isReply)).toHaveLength(1);
  });

  it('a closed watcher socket is dropped', async () => {
    const { manager } = newManager({ known: true });
    const a = fakeWs();
    manager.attach('s1', a.ws, {});
    a.fireClose();
    await manager.wake('s1');
    procs[0]!.onEvent(reply);
    expect(a.sent.some(isReply)).toBe(false);
  });
});

describe('spawns not driven by wake', () => {
  beforeEach(() => { procs.length = 0; });

  it('sendOrResume promotes the sockets already watching', () => {
    const { manager } = newManager({ known: true });
    const a = fakeWs();
    manager.attach('s1', a.ws, {});
    manager.sendOrResume('s1', '/tmp', { text: 'go' });
    procs[0]!.onEvent(reply);
    expect(a.sent.some(isReply)).toBe(true);
    expect(a.sent.filter((m) => m.type === 'session_state')).toHaveLength(2);
  });

  it('spawnDetached promotes the sockets already watching', () => {
    const { manager } = newManager({ known: true });
    const a = fakeWs();
    manager.attach('s1', a.ws, {});
    manager.spawnDetached('s1', '/tmp');
    procs[0]!.onEvent(reply);
    expect(a.sent.some(isReply)).toBe(true);
  });

  it('a socket demoted after /clear rejoins the id it attached to', async () => {
    const { manager } = newManager({ known: true });
    const a = fakeWs();
    manager.attach('old', a.ws, {});
    await manager.wake('old');
    procs[0]!.onEvent({ type: 'session.started', sessionId: 'new', mcpServers: [] });
    await manager.close('new', 'idle');
    await manager.wake('old');
    procs[1]!.onEvent(reply);
    expect(a.sent.filter(isReply)).toHaveLength(1);
  });

  it('a wake during close waits for the exit, then spawns a fresh process', async () => {
    const { manager } = newManager({ known: true });
    await manager.wake('s1');
    const closing = manager.close('s1', 'reauth');
    const woken = manager.wake('s1');
    await Promise.all([closing, woken]);
    expect(procs).toHaveLength(2);
    expect(manager.isActive('s1')).toBe(true);
  });

  it('a closing session is not live', async () => {
    const { manager } = newManager({ known: true });
    await manager.wake('s1');
    const internals = manager as unknown as { active: Map<string, { closeReason?: string }> };
    internals.active.get('s1')!.closeReason = 'reauth';
    expect(manager.isLive('s1')).toBe(false);
  });
});

describe('idle reaper', () => {
  beforeEach(() => { procs.length = 0; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reaps a quiet session even while a client is attached', async () => {
    const { manager } = newManager({ known: true });
    manager.attach('s1', fakeWs().ws, {});
    await manager.wake('s1');
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1);
    expect(manager.isActive('s1')).toBe(false);
  });

  it('skips a session mid-turn', async () => {
    const { manager } = newManager({ known: true });
    await manager.wake('s1');
    manager.sendTurn('s1', { text: 'go' });
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2 + 1);
    expect(manager.isActive('s1')).toBe(true);
  });

  it('skips a session with a pending approval', async () => {
    const { manager } = newManager({ known: true, hasPendingApproval: () => true });
    await manager.wake('s1');
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2 + 1);
    expect(manager.isActive('s1')).toBe(true);
  });
});

describe('activity callbacks', () => {
  beforeEach(() => { procs.length = 0; });

  it('onAssistantReply fires for assistant text, not tool calls or subagent replies', async () => {
    const { manager, onAssistantReply } = newManager({ known: true });
    await manager.wake('s1');
    procs[0]!.onEvent({
      type: 'item.started',
      item: { type: 'tool_call', id: 't', kind: 'command_execution', tool: 'shell', rawName: 'Bash', input: {}, status: 'inProgress' },
    });
    procs[0]!.onEvent({ ...reply, subagent: { parentToolCallId: 'toolu_1' } });
    expect(onAssistantReply).not.toHaveBeenCalled();
    procs[0]!.onEvent(reply);
    expect(onAssistantReply).toHaveBeenCalledWith('s1', expect.any(Number));
  });

  it('onWorkingChange fires true on send and false on markTurnEnded', async () => {
    const { manager, onWorkingChange } = newManager({ known: true });
    await manager.wake('s1');
    manager.sendTurn('s1', { text: 'go' });
    manager.markTurnEnded('s1');
    expect(onWorkingChange.mock.calls).toEqual([['s1', true], ['s1', false]]);
  });
});
