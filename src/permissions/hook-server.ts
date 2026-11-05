// Loopback-only HTTP listener for the outpost MCP server, the orchestrator's `/work/*`
// callbacks and the eval MCP routes. Every endpoint requires the per-launch secret in
// `x-daemon-auth`; the PWA-facing surface is in `src/server.ts`.

import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { parseJsonObject } from '../routes/util.js';

export interface HookServerOpts {
  port: number;
  daemonAuthSecret: string;
  onWorkPlanReady: (body: string) => Promise<void>;
  onWorkStepResolved: (body: string) => Promise<void>;
  onWorkStepFailed: (body: string) => Promise<void>;
  onActionProposal: (body: string) => Promise<void>;
  onWorkJournal: (body: string) => Promise<void>;
  onMcp: (body: string) => Promise<{ status: number; headers: Record<string, string>; body: string }>;
  // Codex's PreToolUse hook command; the returned body is the exact text PRETOOL_HOOK_SCRIPT matches on.
  onCodexPreTool?: (body: string) => Promise<string>;
  // An eval replay's own MCP surfaces: `/mcp/eval/<sid>` stands in for outpost, `/mcp/replay/<sid>/<server>` for the rest.
  onEvalMcp?: (path: string, body: string) => Promise<{ status: number; headers: Record<string, string>; body: string }>;
  // Held by eval replays: opens their own MCP routes, nothing that changes daemon state.
  evalSecret?: string;
  onCreateJob?: (payload: {
    source: string;
    title: string;
    body?: string;
    dedupeKey?: string;
    externalRef?: { url: string; issueIdentifier?: string; linearUuid?: string };
  }) => Promise<{ jobId: string; created: boolean }>;
}

export class HookServer {
  private readonly http: HttpServer;

  constructor(private opts: HookServerOpts) {
    this.http = createServer((req, res) => this.handle(req, res));
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.http.listen(this.opts.port, '127.0.0.1', () => resolve());
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.http.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const KNOWN_ROUTES = new Set([
      '/work/plan-ready',
      '/work/step-resolved',
      '/work/step-failed',
      '/work/action-proposal',
      '/work/journal',
      '/work/create-job',
      '/mcp',
      '/hook/codex/pretool',
    ]);
    const isEvalMcp = /^\/mcp\/(eval|replay)\//.test(req.url ?? '');
    if (req.method !== 'POST' || !(KNOWN_ROUTES.has(req.url ?? '') || isEvalMcp)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const sent = req.headers['x-daemon-auth'];
    const evalAuthed = !!this.opts.evalSecret && sent === this.opts.evalSecret && isEvalMcp;
    if (sent !== this.opts.daemonAuthSecret && !evalAuthed) {
      // Name the route and which way the secret was wrong, or a burst of these is unexplainable from the log.
      const why = sent === undefined ? 'no secret' : 'wrong secret';
      console.log(`[hook-server] 401 ${req.url} from ${req.socket.remoteAddress} (${why})`);
      res.statusCode = 401;
      res.end('unauthorized');
      return;
    }
    const url = req.url;
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', async () => {
      try {
        if (url === '/work/plan-ready') {
          await this.opts.onWorkPlanReady(body);
          res.statusCode = 204;
          res.end();
        } else if (url === '/work/step-resolved') {
          await this.opts.onWorkStepResolved(body);
          res.statusCode = 204;
          res.end();
        } else if (url === '/work/step-failed') {
          await this.opts.onWorkStepFailed(body);
          res.statusCode = 204;
          res.end();
        } else if (url === '/work/action-proposal') {
          await this.opts.onActionProposal(body);
          res.statusCode = 204;
          res.end();
        } else if (url === '/work/journal') {
          await this.opts.onWorkJournal(body);
          res.statusCode = 204;
          res.end();
        } else if (url === '/work/create-job') {
          if (!this.opts.onCreateJob) {
            res.statusCode = 404;
            res.end('not found');
            return;
          }
          // Same guard the daemon's other hook callbacks apply, and for the same reason:
          // `JSON.parse("null")` succeeds, so a bare parse is not a shape check — the field
          // checks below would then 400 on whatever TypeError they happened to raise.
          const raw = parseJsonObject(body);
          if (!raw) throw new Error('invalid json body');
          if (
            typeof raw.source !== 'string' || !raw.source.trim() ||
            typeof raw.title !== 'string' || !raw.title.trim()
          ) {
            res.statusCode = 400;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: 'source and title are required strings' }));
            return;
          }
          const result = await this.opts.onCreateJob({
            source: raw.source,
            title: raw.title,
            body: raw.body != null ? String(raw.body) : undefined,
            dedupeKey: raw.dedupeKey != null ? String(raw.dedupeKey) : undefined,
            externalRef: raw.externalRef as { url: string; issueIdentifier?: string; linearUuid?: string } | undefined,
          });
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(result));
        } else if (url === '/hook/codex/pretool') {
          if (!this.opts.onCodexPreTool) {
            res.statusCode = 404;
            res.end('not found');
            return;
          }
          res.statusCode = 200;
          res.setHeader('content-type', 'text/plain');
          res.end(await this.opts.onCodexPreTool(body));
        } else if (isEvalMcp && this.opts.onEvalMcp) {
          const reply = await this.opts.onEvalMcp(url!, body);
          res.statusCode = reply.status;
          for (const [k, v] of Object.entries(reply.headers)) res.setHeader(k, v);
          res.end(reply.body);
        } else if (url === '/mcp') {
          const reply = await this.opts.onMcp(body);
          res.statusCode = reply.status;
          for (const [k, v] of Object.entries(reply.headers)) res.setHeader(k, v);
          res.end(reply.body);
        } else {
          res.statusCode = 404;
          res.end('not found');
        }
      } catch (e) {
        const msg = (e as Error).message;
        console.error(`[hook-server] handler error (${url}):`, (e as Error).stack);
        if (url?.startsWith('/work/')) {
          // A submitting session must learn its submit failed, not read a 204 as success.
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: msg }));
        } else {
          res.statusCode = 204;
          res.end();
        }
      }
    });
    req.on('error', () => {
      res.statusCode = 400;
      res.end('bad request');
    });
  }
}
