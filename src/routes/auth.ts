import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from '../server.js';
import { LoginError } from '../integrations/cli-login.js';
import type { McpLoginFlows } from '../integrations/mcp-login.js';
import { readAccount, type ClaudeLoginFlows } from '../integrations/claude-login.js';
import type { McpConnectorList } from '../integrations/mcp-connectors.js';
import { readJsonObject } from './util.js';

// Cross-device OAuth, for MCP servers and for Claude Code's own account. The daemon holds a
// `claude … login` open on a pty; the PWA shows its authorization URL, the user authorizes on
// whatever device they have, and pastes the result back here. See integrations/mcp-login.ts and
// integrations/claude-login.ts for why the paste is the only path.
//
// Every route takes its identifiers in a JSON body rather than the path: `Server.route`
// translates `:param` into `[^/]+` for matching but doesn't extract it, so a body avoids
// hand-rolled URL parsing for a server name that can contain anything a config key can.

export interface AuthRoutesDeps {
  loginFlows: McpLoginFlows;
  claudeLogin: ClaudeLoginFlows;
  connectors: McpConnectorList;
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

function failLogin(res: ServerResponse, e: unknown, prefix = ''): void {
  const err = e as LoginError;
  fail(res, err.statusCode ?? 500, `${prefix}${err.message}`);
}

export function registerAuthRoutes(server: Server, deps: AuthRoutesDeps): void {
  const { loginFlows, claudeLogin, connectors } = deps;

  server.route('GET', '/api/mcp/auth/flows', (_req, res) => {
    sendJson(res, { flows: loginFlows.list() });
  });

  // Slow (a health check per server) and cached — fetched on the panel's own schedule so it
  // never delays the local-server rows, same split as /api/mcp/catalog.
  server.route('GET', '/api/mcp/connectors', async (req: IncomingMessage, res: ServerResponse) => {
    const force = new URL(req.url ?? '', 'http://internal').searchParams.get('refresh') === '1';
    try {
      sendJson(res, { connectors: await connectors.list(force) });
    } catch (e) {
      fail(res, 502, (e as Error).message);
    }
  });

  server.route('POST', '/api/mcp/auth/start', async (req: IncomingMessage, res: ServerResponse) => {
    const payload = await readJsonObject<{ server?: unknown }>(req, res);
    if (!payload) return;
    const name = payload.server;
    if (typeof name !== 'string' || name.length === 0) return fail(res, 400, 'server is required');
    // Existence is NOT checked here: the CLI knows about ~30 claude.ai connectors that no local
    // config lists, and gating on `mergeMcpServers` refused every one of them — including the
    // Linear/Slack/DataDog connectors this repo's own permission groups depend on. The CLI
    // answers with its own 404 instead. What still has to be checked is the argv shape, since
    // the name reaches a spawned argv: a leading `-` would be read as a flag (the smuggling
    // guard worktree-manager.ts documents), and a control character has no business in a name.
    if (name.startsWith('-')) return fail(res, 400, 'server name may not start with "-"');
    if (name.length > 200 || /[\0-\x1f\x7f]/.test(name)) return fail(res, 400, 'invalid server name');

    try {
      sendJson(res, { flow: await loginFlows.start(name) });
    } catch (e) {
      failLogin(res, e, 'could not start the login: ');
    }
  });

  server.route('POST', '/api/mcp/auth/submit', async (req: IncomingMessage, res: ServerResponse) => {
    const payload = await readJsonObject<{ flowId?: unknown; redirectUrl?: unknown }>(req, res);
    if (!payload) return;
    const { flowId, redirectUrl } = payload;
    if (typeof flowId !== 'string' || flowId.length === 0) return fail(res, 400, 'flowId is required');
    if (typeof redirectUrl !== 'string' || redirectUrl.length === 0) return fail(res, 400, 'redirectUrl is required');

    try {
      sendJson(res, { flow: await loginFlows.submitRedirect(flowId, redirectUrl) });
    } catch (e) {
      failLogin(res, e);
    }
  });

  server.route('POST', '/api/mcp/auth/cancel', async (req: IncomingMessage, res: ServerResponse) => {
    const payload = await readJsonObject<{ flowId?: unknown }>(req, res);
    if (!payload) return;
    const { flowId } = payload;
    if (typeof flowId !== 'string' || flowId.length === 0) return fail(res, 400, 'flowId is required');
    sendJson(res, { cancelled: loginFlows.cancel(flowId) });
  });

  // The claude.ai connector half of "done": no exchange happened here, so this is the only
  // signal that the grant has landed and sessions are worth reloading.
  server.route('POST', '/api/mcp/auth/done', async (req: IncomingMessage, res: ServerResponse) => {
    const payload = await readJsonObject<{ flowId?: unknown }>(req, res);
    if (!payload) return;
    const { flowId } = payload;
    if (typeof flowId !== 'string' || flowId.length === 0) return fail(res, 400, 'flowId is required');
    sendJson(res, { finished: loginFlows.finishHandoff(flowId) });
  });

  // Claude Code's own account. `flow` is returned alongside the account so a login begun on
  // another device is picked up by whichever client asks next — the case this exists for.
  server.route('GET', '/api/claude/auth', async (_req, res) => {
    sendJson(res, {
      account: await readAccount(),
      failedSince: claudeLogin.failedSince(),
      flow: claudeLogin.current(),
    });
  });

  server.route('POST', '/api/claude/auth/start', async (_req, res) => {
    try {
      sendJson(res, { flow: await claudeLogin.start() });
    } catch (e) {
      failLogin(res, e, 'could not start the login: ');
    }
  });

  server.route('POST', '/api/claude/auth/submit', async (req: IncomingMessage, res: ServerResponse) => {
    const payload = await readJsonObject<{ flowId?: unknown; code?: unknown }>(req, res);
    if (!payload) return;
    const { flowId, code } = payload;
    if (typeof flowId !== 'string' || flowId.length === 0) return fail(res, 400, 'flowId is required');
    if (typeof code !== 'string' || code.length === 0) return fail(res, 400, 'code is required');

    try {
      sendJson(res, { flow: await claudeLogin.submitCode(flowId, code) });
    } catch (e) {
      failLogin(res, e);
    }
  });

  server.route('POST', '/api/claude/auth/cancel', async (req: IncomingMessage, res: ServerResponse) => {
    const payload = await readJsonObject<{ flowId?: unknown }>(req, res);
    if (!payload) return;
    const { flowId } = payload;
    if (typeof flowId !== 'string' || flowId.length === 0) return fail(res, 400, 'flowId is required');
    sendJson(res, { cancelled: claudeLogin.cancel(flowId) });
  });
}
