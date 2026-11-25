import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HookServer } from '../../src/permissions/hook-server.js';
import { AcpConnection } from '../../src/runtime/acp/connection.js';
import { findOnPath } from '../../src/runtime/bin.js';
import { cursorProjectSlug } from '../../src/runtime/cursor/hooks.js';
import { CursorRuntime } from '../../src/runtime/cursor/runtime.js';
import { JsonlTranscripts } from '../../src/runtime/jsonl-transcripts.js';
import type { CanonicalEvent, GateRequest, RuntimeHost } from '../../src/runtime/types.js';
import { freePort } from '../e2e/harness/port.js';

const bin = process.env.OUTPOST_CURSOR_LIVE ? findOnPath('agent') : null;
const REPORT = '/tmp/outpost-cursor-probe.json';
const STEPS = ['preToolUse', 'beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile', 'subagentStart'];
const ALLOW = '{"permission":"allow"}';
const DENY = JSON.stringify({ permission: 'deny', user_message: 'probe deny' });
const PROBE_ENV = 'probe-env-ok';

interface TraceEvent { seq: number; source: 'hook' | 'notify' | 'request'; step?: string; env?: string; payload?: unknown; method?: string; params?: unknown }
interface Trace { events: TraceEvent[]; authError?: string; mcpCalls: number }

const report: Record<string, unknown> = { reportedAt: new Date().toISOString() };

// Evidence for the `cursor` runtime's capability flags (see docs/design/permissions.md); re-run on every Cursor upgrade.
describe.skipIf(!bin)('Cursor hooks over ACP (live probe)', () => {
  let hookServer: Server;
  let mcp: Server;
  let hookPort = 0;
  let mcpUrl = '';
  let trustArgs: string[] = [];
  let dataDirMode: 'session' | 'home' = 'session';
  let seq = 0;
  let current: Trace = { events: [], mcpCalls: 0 };
  let decide: (step: string, payload: Record<string, unknown>) => string = () => ALLOW;

  beforeAll(async () => {
    hookServer = createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => { body += d.toString(); });
      req.on('end', () => {
        const step = String(req.headers['x-step'] ?? '');
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse(body) as Record<string, unknown>; } catch { payload = { unparsed: body }; }
        current.events.push({ seq: seq++, source: 'hook', step, env: String(req.headers['x-env'] ?? ''), payload });
        res.end(req.headers['x-mode'] === 'ping' ? '' : decide(step, payload));
      });
    });
    await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', r));
    hookPort = (hookServer.address() as AddressInfo).port;
    mcp = createServer((req, res) => answerMcp(req, res, () => { current.mcpCalls++; }));
    await new Promise<void>((r) => mcp.listen(0, '127.0.0.1', r));
    mcpUrl = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`;
    report.cursorVersion = execFileSync(bin!, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
    report.wireFormat = { allow: ALLOW, deny: DENY, source: 'validators in ~/.local/share/cursor-agent/versions/*/9622.index.js' };
  });

  afterAll(async () => {
    writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
    await new Promise<void>((r) => hookServer.close(() => r()));
    await new Promise<void>((r) => mcp.close(() => r()));
  });

  function scenarioDir(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), `outpost-cursor-${name}-`));
    writeFileSync(join(dir, 'README.md'), 'Lighthouse keepers log every ship.\n');
    writeFileSync(join(dir, 'victim.txt'), 'delete me\n');
    // Records the call with the test's hook server, then answers with whatever the server decided.
    writeFileSync(join(dir, 'record.sh'), `curl -sS --max-time 20 --data-binary @- -H "x-step: $1" -H "x-env: \${OUTPOST_PROBE_ENV:-unset}" http://127.0.0.1:${hookPort}/hook\n`);
    const ping = `curl -sS --max-time 20 --data-binary @- -H "x-step: $1" -H "x-mode: ping" -H "x-env: \${OUTPOST_PROBE_ENV:-unset}" http://127.0.0.1:${hookPort}/hook >/dev/null\n`;
    writeFileSync(join(dir, 'fail-exit1.sh'), `${ping}exit 1\n`);
    writeFileSync(join(dir, 'fail-empty.sh'), `${ping}exit 0\n`);
    writeFileSync(join(dir, 'fail-garbage.sh'), `${ping}echo nope\n`);
    writeFileSync(join(dir, 'fail-sleep.sh'), `${ping}sleep 10\necho '${ALLOW}'\n`);
    return dir;
  }

  // `agent acp` reads project hooks from <data dir>/projects/<slug of cwd>/.cursor/hooks.json, not <cwd>/.cursor/.
  function hookPaths(dir: string): string[] {
    const root = dataDirMode === 'session' ? join(dir, '.cursor-data') : join(homedir(), '.cursor');
    return [...new Set([dir, realpathSync(dir)])].map((d) => join(root, 'projects', cursorProjectSlug(d), '.cursor', 'hooks.json'));
  }

  function sessionEnv(dir: string): Record<string, string> {
    return dataDirMode === 'session' ? { CURSOR_DATA_DIR: join(dir, '.cursor-data') } : {};
  }

  function installHooks(dir: string, hooks: Record<string, { command: string; timeout?: number }>): void {
    const entries = Object.entries(hooks).map(([step, h]) => [step, [{ command: h.command, failClosed: true, timeout: h.timeout ?? 30 }]]);
    for (const path of hookPaths(dir)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ version: 1, hooks: Object.fromEntries(entries) }, null, 2));
    }
  }

  async function run(dir: string, prompts: string[], opts: { env?: Record<string, string>; betweenTurns?: (i: number) => void } = {}): Promise<Trace> {
    const trace: Trace = { events: [], mcpCalls: 0 };
    current = trace;
    const conn = new AcpConnection({
      command: bin!,
      args: ['acp', ...trustArgs],
      env: { ...process.env, OUTPOST_PROBE_ENV: PROBE_ENV, ...sessionEnv(dir), ...opts.env },
      cwd: dir,
      onNotification: (method, params) => { trace.events.push({ seq: seq++, source: 'notify', method, params }); },
      onRequest: async (method, params) => {
        trace.events.push({ seq: seq++, source: 'request', method, params });
        if (method !== 'session/request_permission') throw new Error(`probe can't answer ${method}`);
        const options = (params as { options?: { optionId: string; kind: string }[] }).options ?? [];
        const once = options.find((o) => o.kind === 'allow_once') ?? options[0];
        return once ? { outcome: { outcome: 'selected', optionId: once.optionId } } : { outcome: { outcome: 'cancelled' } };
      },
      onStderr: () => {},
      onExit: () => {},
    });
    try {
      await conn.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'outpost-probe', version: '0.1.0' },
      });
      try {
        await conn.request('authenticate', { methodId: 'cursor_login' });
      } catch (e) {
        trace.authError = (e as Error).message;
        return trace;
      }
      const { sessionId } = await conn.request<{ sessionId: string }>('session/new', {
        cwd: dir, mcpServers: [{ type: 'http', name: 'probe', url: mcpUrl, headers: [] }],
      }, 120_000);
      for (const [i, text] of prompts.entries()) {
        if (i > 0) opts.betweenTurns?.(i);
        await conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 300_000);
      }
    } finally {
      await conn.kill();
    }
    return trace;
  }

  it('P1/P3/P4/P5: which hooks fire, with what, and against which ACP call ids', async () => {
    const dir = scenarioDir('record');
    installHooks(dir, Object.fromEntries(STEPS.map((s) => [s, { command: `sh ${join(dir, 'record.sh')} ${s}` }])));
    const prompt = 'Do each of these with your tools, in order, then reply "done": '
      + '1) read README.md; 2) create a file out.txt containing exactly: hi; 3) run the shell command `echo probe`; '
      + '4) delete the file out.txt; 5) call the `ping` tool from the `probe` MCP server once.';
    let trace = await run(dir, [prompt]);
    report.dataDirAuthError = trace.authError ?? null;
    if (trace.authError) {
      dataDirMode = 'home';
      installHooks(dir, Object.fromEntries(STEPS.map((s) => [s, { command: `sh ${join(dir, 'record.sh')} ${s}` }])));
      trace = await run(dir, [prompt]);
    }
    if (!trace.events.some((e) => e.source === 'hook') && !trace.authError) {
      trustArgs = ['--trust'];
      trace = await run(dir, [prompt]);
    }
    report.hookLocation = dataDirMode === 'session' ? 'per-session CURSOR_DATA_DIR' : '~/.cursor/projects/<slug>';
    report.hookPaths = hookPaths(dir);
    report.trustFlagNeeded = trustArgs.length > 0;
    report.record = summarize(trace);
    const hooks = trace.events.filter((e) => e.source === 'hook');
    const calls = toolCalls(trace);

    report.p1 = { stepsSeen: [...new Set(hooks.map((h) => h.step))] };
    report.p3 = { envReachedHook: hooks.length > 0 && hooks.every((h) => h.env === PROBE_ENV) };
    report.p4 = correlation(trace);
    const write = hooks.find((h) => h.step === 'preToolUse' && (h.payload as { tool_name?: string }).tool_name === 'Write');
    report.p5 = { writeViaPreToolUse: !!write, writeInput: (write?.payload as { tool_input?: unknown } | undefined)?.tool_input ?? null };
    report.payloadFieldsByStep = Object.fromEntries(STEPS.map((s) => [s, [...new Set(hooks.filter((h) => h.step === s)
      .flatMap((h) => Object.keys((h.payload ?? {}) as object)))]]));
    report.preToolUseToolNames = [...new Set(hooks.filter((h) => h.step === 'preToolUse').map((h) => (h.payload as { tool_name?: string }).tool_name))];
    report.callsWithoutHook = calls.filter((c) => !hooks.some((h) => (h.payload as { tool_use_id?: string }).tool_use_id === c.id))
      .map((c) => ({ id: c.id, kind: c.kind, title: c.title, status: c.status }));
    report.p8 = { toolCallsWithoutId: calls.filter((c) => !c.id).length };

    expect(trace.authError).toBeUndefined();
    expect((report.p1 as { stepsSeen: string[] }).stepsSeen).toContain('preToolUse');
    expect((report.p3 as { envReachedHook: boolean }).envReachedHook).toBe(true);
    expect((report.p4 as { allCorrelated: boolean }).allCorrelated).toBe(true);
    expect((report.p5 as { writeViaPreToolUse: boolean }).writeViaPreToolUse).toBe(true);
  }, 600_000);

  it('P2: a failClosed preToolUse hook that fails in any way blocks the write', async () => {
    const modes: Record<string, { script?: string; command?: string; timeout?: number }> = {
      exit1: { script: 'fail-exit1.sh' },
      emptyStdout: { script: 'fail-empty.sh' },
      invalidJson: { script: 'fail-garbage.sh' },
      timeout: { script: 'fail-sleep.sh', timeout: 2 },
      missingBinary: { command: '/nonexistent/outpost-probe-hook' },
    };
    const results: Record<string, { hookRan: boolean; fileWritten: boolean }> = {};
    for (const [mode, m] of Object.entries(modes)) {
      const dir = scenarioDir(`fail-${mode}`);
      installHooks(dir, { preToolUse: { command: m.command ?? `sh ${join(dir, m.script!)} preToolUse`, timeout: m.timeout } });
      const trace = await run(dir, ['Create a file out.txt in this directory containing exactly: hi. If the tool is blocked, reply "blocked" and stop.']);
      results[mode] = { hookRan: trace.events.some((e) => e.source === 'hook'), fileWritten: existsSync(join(dir, 'out.txt')) };
    }
    report.p2Modes = results;
    for (const r of Object.values(results)) expect(r.fileWritten).toBe(false);
  }, 1_800_000);

  it('P2: a failing failClosed hook blocks shell, delete and MCP calls too', async () => {
    const dir = scenarioDir('fail-tools');
    installHooks(dir, { preToolUse: { command: `sh ${join(dir, 'fail-exit1.sh')} preToolUse` } });
    const trace = await run(dir, [
      'Run the shell command `touch shell-ran.txt`. If it is blocked, reply "blocked" and stop.',
      'Delete the file victim.txt. If it is blocked, reply "blocked" and stop.',
      'Call the `ping` tool from the `probe` MCP server once. If it is blocked, reply "blocked" and stop.',
    ]);
    report.p2Tools = {
      shellRan: existsSync(join(dir, 'shell-ran.txt')),
      deleted: !existsSync(join(dir, 'victim.txt')),
      mcpCalled: trace.mcpCalls > 0,
      hookCalls: trace.events.filter((e) => e.source === 'hook').length,
    };
    expect(report.p2Tools).toMatchObject({ shellRan: false, deleted: false, mcpCalled: false });
  }, 900_000);

  it('P6: whether deleting hooks.json mid-session re-opens the gate', async () => {
    const dir = scenarioDir('tamper');
    installHooks(dir, { preToolUse: { command: `sh ${join(dir, 'record.sh')} preToolUse` } });
    decide = (_step, p) => (p.tool_name === 'Write' ? DENY : ALLOW);
    let out1AfterTurn1 = false;
    try {
      const trace = await run(dir, [
        'Create a file out1.txt containing exactly: hi. If it is blocked, reply "blocked" and stop.',
        'Create a file out2.txt containing exactly: hi. If it is blocked, reply "blocked" and stop.',
      ], {
        betweenTurns: () => {
          out1AfterTurn1 = existsSync(join(dir, 'out1.txt'));
          for (const p of hookPaths(dir)) rmSync(p);
        },
      });
      const out2 = existsSync(join(dir, 'out2.txt'));
      report.p6 = {
        firstWriteBlocked: !out1AfterTurn1,
        out1AtEnd: existsSync(join(dir, 'out1.txt')),
        secondWriteRanAfterDelete: out2,
        hooks: out2 ? 're-read per call: deleting hooks.json opens the gate' : 'snapshotted at session start',
        hookCalls: trace.events.filter((e) => e.source === 'hook').length,
      };
    } finally {
      decide = () => ALLOW;
    }
  }, 900_000);

  // A Write deny alone doesn't stop an edit (P6); the runtime decides an edit at its Read hook instead.
  it('P6b: denying an edit at its Read hook stops the write', async () => {
    const dir = scenarioDir('edit-at-read');
    installHooks(dir, { preToolUse: { command: `sh ${join(dir, 'record.sh')} preToolUse` } });
    decide = (_step, p) => {
      const isEdit = toolCalls(current).some((c) => c.id === p.tool_use_id && c.kind === 'edit');
      return (p.tool_name === 'Read' && isEdit) || p.tool_name === 'Shell' ? DENY : ALLOW;
    };
    try {
      const trace = await run(dir, ['Using your file edit tool (not the shell), create a file out.txt containing exactly: hi. If it is blocked, reply "blocked" and stop.']);
      const hooks = trace.events.filter((e) => e.source === 'hook').map((h) => (h.payload as { tool_name?: string }).tool_name);
      report.p6b = { fileWritten: existsSync(join(dir, 'out.txt')), hooks };
      expect(report.p6b).toMatchObject({ fileWritten: false });
    } finally {
      decide = () => ALLOW;
    }
  }, 900_000);

  it('P7/P9: web search under a pinned per-session CURSOR_CONFIG_DIR', async () => {
    const dir = scenarioDir('web');
    installHooks(dir, Object.fromEntries(STEPS.map((s) => [s, { command: `sh ${join(dir, 'record.sh')} ${s}` }])));
    const cfgDir = join(dir, '.cursor-config');
    mkdirSync(cfgDir, { recursive: true });
    const userCfgPath = join(homedir(), '.cursor', 'cli-config.json');
    const userCfg = existsSync(userCfgPath) ? JSON.parse(readFileSync(userCfgPath, 'utf8')) as Record<string, unknown> : {};
    writeFileSync(join(cfgDir, 'cli-config.json'), JSON.stringify({
      ...userCfg, approvalMode: 'allowlist', permissions: { allow: [], deny: [] }, autoAcceptWebSearch: false,
    }, null, 2));
    const prompt = 'Search the web for the current Node.js LTS version and reply with just the version number.';
    let trace = await run(dir, [prompt], { env: { CURSOR_CONFIG_DIR: cfgDir } });
    report.p9 = { authSurvivesConfigDir: !trace.authError, authError: trace.authError ?? null };
    if (trace.authError) trace = await run(dir, [prompt]);
    const hooks = trace.events.filter((e) => e.source === 'hook');
    const asked = new Set(trace.events.filter((e) => e.source === 'request')
      .map((e) => (e.params as { toolCall?: { toolCallId?: string } }).toolCall?.toolCallId));
    const web = toolCalls(trace).filter((c) => /web/i.test(c.title ?? ''));
    report.p7 = {
      webCalls: web.map((c) => ({
        id: c.id, kind: c.kind, title: c.title, status: c.status,
        asked: asked.has(c.id),
        hooked: hooks.some((h) => (h.payload as { tool_use_id?: string }).tool_use_id === c.id),
      })),
      verdict: web.length === 0 ? 'untriggered' : web.every((c) => asked.has(c.id) || hooks.some((h) => (h.payload as { tool_use_id?: string }).tool_use_id === c.id)) ? 'gated' : 'ungated',
    };
    report.web = summarize(trace);
  }, 900_000);

  it('D6: semantic search, image generation and Task reach a hook', async () => {
    const scenarios: Record<string, { prompt: string; match: RegExp }> = {
      semSearch: { prompt: 'Use semantic codebase search to find where ships are mentioned in this directory, then reply with the file name.', match: /sem|codebase/i },
      generateImage: { prompt: 'Generate an image of a lighthouse and save it in this directory.', match: /image/i },
      task: { prompt: 'Use a subagent (Task tool) to read README.md and report its first word.', match: /task|subagent/i },
    };
    const d6: Record<string, unknown> = {};
    for (const [name, s] of Object.entries(scenarios)) {
      const dir = scenarioDir(`d6-${name}`);
      installHooks(dir, Object.fromEntries(STEPS.map((step) => [step, { command: `sh ${join(dir, 'record.sh')} ${step}` }])));
      const trace = await run(dir, [s.prompt]);
      const hooks = trace.events.filter((e) => e.source === 'hook');
      const hookIds = new Set(hooks.map((h) => (h.payload as { tool_use_id?: string }).tool_use_id));
      const matching = toolCalls(trace).filter((c) => s.match.test(`${c.kind} ${c.title}`));
      const hookedByName = hooks.some((h) => s.match.test(`${h.step} ${(h.payload as { tool_name?: string }).tool_name ?? ''}`));
      const verdict = matching.length === 0 && !hookedByName ? 'untriggered'
        : matching.every((c) => hookIds.has(c.id)) || hookedByName ? (matching.some((c) => c.status === 'failed') ? 'refused' : 'hooked')
          : 'ungated';
      d6[name] = {
        verdict,
        calls: toolCalls(trace).map((c) => ({ kind: c.kind, title: c.title, status: c.status, hooked: hookIds.has(c.id) })),
        hooks: hooks.map((h) => ({ step: h.step, tool: (h.payload as { tool_name?: string }).tool_name ?? null })),
      };
    }
    report.d6 = d6;
  }, 1_800_000);

  it('CursorRuntime end to end: everything reaches the gate, and a denied edit is not written', async () => {
    const dir = scenarioDir('runtime');
    const gated: GateRequest[] = [];
    const failures: string[] = [];
    let errors = '';
    const host: RuntimeHost = {
      gateToolCall: async (r) => {
        gated.push(r);
        const denied = r.tool === 'file_write' && String((r.input as { file_path?: string }).file_path).endsWith('blocked.txt');
        return denied ? { allow: false, reason: 'blocked.txt is off limits' } : { allow: true };
      },
      onToolFailed: () => {}, onToolCompleted: () => {}, onUsage: () => {}, onTurnEnded: () => {},
      onTurnFailed: (_id, code) => { failures.push(code); },
    };
    const port = await freePort();
    const runtime = new CursorRuntime({
      bin, host: () => host, mcpServers: () => new Map([['probe', { type: 'http', url: mcpUrl }]]), approvalTimeoutMs: 60_000,
      daemonAuthSecret: 'probe-secret', hookPort: port, runtimeDir: join(dir, '.outpost'),
      transcripts: new JsonlTranscripts(join(dir, '.transcripts')), nativeIds: { read: () => null, write: () => {} }, actionBody: () => undefined,
    });
    const noop = async () => {};
    const server = new HookServer({
      port, daemonAuthSecret: 'probe-secret', onWorkPlanReady: noop, onWorkStepResolved: noop, onWorkStepFailed: noop,
      onActionProposal: noop, onWorkJournal: noop, onMcp: async () => ({ status: 404, headers: {}, body: '' }),
      onCursorHook: async (body, session) => {
        const answer = await runtime.handleHook(body, session);
        const p = JSON.parse(body) as { tool_name?: string; tool_use_id?: string };
        hookCalls.push({ tool: p.tool_name, id: p.tool_use_id, answer });
        return answer;
      },
    });
    const hookCalls: unknown[] = [];
    report.runtimeHooks = hookCalls;
    await server.listen();
    try {
      await new Promise<void>((resolve, reject) => {
        const session = runtime.start({ sessionId: `live-${Date.now()}`, mode: 'new', cwd: dir, env: {}, isAction: true }, {
          onEvent: (e: CanonicalEvent) => { if (e.type === 'turn.completed') void session.kill().then(resolve); },
          onError: (m) => { errors += m; },
          onExit: (code) => reject(new Error(`agent exited ${code} before the turn ended: ${errors}`)),
        });
        session.sendTurn({
          text: 'Do each of these with your tools, in order, then reply "done": 1) read README.md; '
            + '2) with your file edit tool, create out.txt containing exactly: hi; '
            + '3) with your file edit tool, create blocked.txt containing exactly: no (if refused, do not retry another way); '
            + '4) run the shell command `echo probe`; 5) call the `ping` tool from the `probe` MCP server once.',
        });
      });
    } finally {
      await server.close();
    }
    report.runtime = {
      failures, gated: gated.map((g) => ({ tool: g.tool, input: g.input })),
      outWritten: existsSync(join(dir, 'out.txt')), blockedWritten: existsSync(join(dir, 'blocked.txt')),
    };
    expect(failures).not.toContain('ungated_tool_call');
    expect(report.runtime).toMatchObject({ outWritten: true, blockedWritten: false });
    expect(gated.map((g) => g.tool)).toEqual(expect.arrayContaining(['file_read', 'file_write', 'shell', 'mcp:probe/ping']));
  }, 900_000);
});

interface CallView { id: string; kind?: string; title?: string; status?: string; firstSeq: number; doneSeq?: number }

// The final view of every ACP tool call in a trace, merged across its updates.
function toolCalls(trace: Trace): CallView[] {
  const byId = new Map<string, CallView>();
  for (const e of trace.events) {
    if (e.source !== 'notify' || e.method !== 'session/update') continue;
    const u = (e.params as { update?: { sessionUpdate?: string; toolCallId?: string; kind?: string; title?: string; status?: string } }).update;
    if (!u || (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update')) continue;
    const id = u.toolCallId ?? '';
    const c = byId.get(id) ?? { id, firstSeq: e.seq };
    if (u.kind) c.kind = u.kind;
    if (u.title) c.title = u.title;
    if (u.status) c.status = u.status;
    if (u.status === 'completed' || u.status === 'failed') c.doneSeq ??= e.seq;
    byId.set(id, c);
  }
  return [...byId.values()];
}

// Read/edit hooks carry the ACP toolCallId; shell and MCP hooks carry their own id, so only the former can correlate.
function correlation(trace: Trace): { allCorrelated: boolean; calls: unknown[] } {
  const hooks = trace.events.filter((e) => e.source === 'hook');
  const requests = trace.events.filter((e) => e.source === 'request');
  const calls = toolCalls(trace).filter((c) => c.kind !== 'think' && c.kind !== 'switch_mode').map((c) => {
    const hook = hooks.filter((h) => (h.payload as { tool_use_id?: string }).tool_use_id === c.id);
    const req = requests.find((r) => (r.params as { toolCall?: { toolCallId?: string } }).toolCall?.toolCallId === c.id);
    return {
      id: c.id, kind: c.kind, title: c.title, status: c.status,
      hookSteps: hook.map((h) => h.step),
      order: [
        { what: 'tool_call', seq: c.firstSeq },
        ...hook.map((h) => ({ what: `hook:${h.step}`, seq: h.seq })),
        ...(req ? [{ what: 'request_permission', seq: req.seq }] : []),
        ...(c.doneSeq !== undefined ? [{ what: 'done', seq: c.doneSeq }] : []),
      ].sort((a, b) => a.seq - b.seq).map((o) => o.what),
    };
  });
  const idCarrying = calls.filter((c) => c.kind === 'read' || c.kind === 'edit');
  return { allCorrelated: idCarrying.length > 0 && idCarrying.every((c) => c.hookSteps.length > 0), calls };
}

function summarize(trace: Trace): unknown {
  return {
    authError: trace.authError ?? null,
    mcpCalls: trace.mcpCalls,
    hooks: trace.events.filter((e) => e.source === 'hook').map((h) => ({ seq: h.seq, step: h.step, env: h.env, payload: h.payload })),
    requests: trace.events.filter((e) => e.source === 'request').map((r) => ({ seq: r.seq, method: r.method, params: r.params })),
    toolCalls: toolCalls(trace),
  };
}

// A one-tool MCP server over streamable HTTP, answering with plain JSON.
function answerMcp(req: IncomingMessage, res: ServerResponse, onCall: () => void): void {
  if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
  let body = '';
  req.on('data', (d: Buffer) => { body += d.toString(); });
  req.on('end', () => {
    const msg = JSON.parse(body) as { id?: number | string; method: string };
    if (msg.id === undefined) { res.statusCode = 202; res.end(); return; }
    if (msg.method === 'tools/call') onCall();
    const result = msg.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } }
      : msg.method === 'tools/list'
        ? { tools: [{ name: 'ping', description: 'Replies pong', inputSchema: { type: 'object', properties: {} } }] }
        : msg.method === 'tools/call'
          ? { content: [{ type: 'text', text: 'pong' }] }
          : undefined;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result === undefined
      ? { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no ${msg.method}` } }
      : { jsonrpc: '2.0', id: msg.id, result }));
  });
}
