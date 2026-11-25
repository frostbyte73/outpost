import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from '../server.js';
import { LoginError } from '../integrations/cli-login.js';
import {
  isLoginRuntime, readRuntimeAccount, type LoginRuntime, type RuntimeAccount, type RuntimeLoginFlow, type RuntimeLoginFlows,
} from '../integrations/runtime-login.js';
import { addAcpAgent, removeAcpAgent, type AcpAgentConfig } from '../runtime/acp/config.js';
import { AcpRuntime } from '../runtime/acp/runtime.js';
import { runtimeLabel, type RuntimeRegistry } from '../runtime/registry.js';
import { RUNTIME_IDS, isRuntimeId, type AgentRuntime } from '../runtime/types.js';
import { readJsonObject } from './util.js';

// The Runtimes settings page: what harnesses the daemon can run sessions on, whether each is
// signed in, and the sign-in flows for the ones that have one. Claude's own sign-in keeps its
// routes in auth.ts — it needs a pasted code — and this list only names it.

export interface RuntimesRoutesDeps {
  runtimes: RuntimeRegistry;
  login: RuntimeLoginFlows;
  resolveBin: (runtime: LoginRuntime) => string | null;
  acpAgentsPath: string;
  buildAcpRuntime: (agent: AcpAgentConfig) => AgentRuntime;
}

export interface RuntimeEntry {
  id: string;
  label: string;
  kind: 'claude' | 'codex' | 'cursor' | 'acp';
  available: boolean;
  // Whether the daemon can drive a sign-in for this runtime from the page.
  canLogin: boolean;
  command?: string;
  args?: string[];
  account?: RuntimeAccount;
  flow?: RuntimeLoginFlow | null;
}

function fail(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain');
  res.end(message);
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function kindOf(id: string): RuntimeEntry['kind'] {
  return (RUNTIME_IDS as readonly string[]).includes(id) ? id as RuntimeEntry['kind'] : 'acp';
}

async function describe(rt: AgentRuntime, deps: RuntimesRoutesDeps): Promise<RuntimeEntry> {
  const kind = kindOf(rt.id);
  const entry: RuntimeEntry = {
    id: rt.id,
    label: rt.label ?? (isRuntimeId(rt.id) ? runtimeLabel(rt.id) : rt.id),
    kind,
    available: rt.available,
    canLogin: isLoginRuntime(kind),
  };
  if (rt instanceof AcpRuntime) {
    entry.command = rt.opts.agent.command;
    entry.args = rt.opts.agent.args;
  }
  if (isLoginRuntime(kind)) {
    const bin = deps.resolveBin(kind);
    if (rt.available && bin) entry.account = await readRuntimeAccount(kind, bin);
    entry.flow = deps.login.current(kind);
  }
  return entry;
}

export function registerRuntimesRoutes(server: Server, deps: RuntimesRoutesDeps): void {
  const { runtimes, login } = deps;

  async function readRuntime(req: IncomingMessage, res: ServerResponse): Promise<LoginRuntime | null> {
    const payload = await readJsonObject<{ runtime?: unknown }>(req, res);
    if (!payload) return null;
    if (!isLoginRuntime(payload.runtime)) {
      fail(res, 400, 'runtime must be codex or cursor — Claude signs in through /api/claude/auth');
      return null;
    }
    return payload.runtime;
  }

  server.route('GET', '/api/runtimes', async (_req, res) => {
    sendJson(res, { runtimes: await Promise.all(runtimes.all().map((rt) => describe(rt, deps))) });
  });

  server.route('POST', '/api/runtimes/auth/start', async (req: IncomingMessage, res: ServerResponse) => {
    const runtime = await readRuntime(req, res);
    if (!runtime) return;
    try {
      sendJson(res, { flow: await login.start(runtime) });
    } catch (e) {
      const err = e as LoginError;
      fail(res, err.statusCode ?? 500, `could not start the login: ${err.message}`);
    }
  });

  server.route('POST', '/api/runtimes/auth/cancel', async (req: IncomingMessage, res: ServerResponse) => {
    const runtime = await readRuntime(req, res);
    if (!runtime) return;
    sendJson(res, { cancelled: login.cancel(runtime) });
  });

  server.route('POST', '/api/runtimes/acp', async (req: IncomingMessage, res: ServerResponse) => {
    const payload = await readJsonObject<Record<string, unknown>>(req, res);
    if (!payload) return;
    let agent: AcpAgentConfig;
    try {
      agent = addAcpAgent(deps.acpAgentsPath, payload);
    } catch (e) {
      return fail(res, 400, (e as Error).message);
    }
    const rt = deps.buildAcpRuntime(agent);
    runtimes.register(rt);
    sendJson(res, { runtime: await describe(rt, deps) });
  });

  server.route('DELETE', '/api/runtimes/acp', async (req: IncomingMessage, res: ServerResponse) => {
    const payload = await readJsonObject<{ id?: unknown }>(req, res);
    if (!payload) return;
    if (typeof payload.id !== 'string' || !payload.id) return fail(res, 400, 'id is required');
    try {
      if (!removeAcpAgent(deps.acpAgentsPath, payload.id)) return fail(res, 404, `no ACP agent ${payload.id}`);
    } catch (e) {
      return fail(res, 400, (e as Error).message);
    }
    runtimes.unregister(`acp:${payload.id}`);
    sendJson(res, { removed: true });
  });
}
