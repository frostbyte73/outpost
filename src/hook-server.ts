// Loopback-only HTTP listener for the PreToolUse hook callbacks from `claude`.
// Claude Code's HTTP hooks have SSRF protection — they only accept loopback URLs (127.0.0.1, ::1).
// The PWA + WSS surface remains on the Tailscale-bound HTTPS server in src/server.ts.

import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface HookServerOpts {
  port: number;
  daemonAuthSecret: string;
  onHookCall: (body: string) => Promise<string>;
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

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || req.url !== '/hook/pretool') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (req.headers['x-daemon-auth'] !== this.opts.daemonAuthSecret) {
      console.log(`[hook-server] 401 from ${req.socket.remoteAddress}`);
      res.statusCode = 401;
      res.end('unauthorized');
      return;
    }
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', async () => {
      try {
        const result = await this.opts.onHookCall(body);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(result);
      } catch (e) {
        console.error('[hook-server] handler error:', (e as Error).stack);
        res.statusCode = 500;
        res.end('error');
      }
    });
    req.on('error', () => {
      res.statusCode = 400;
      res.end('bad request');
    });
  }
}
