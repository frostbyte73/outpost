// Loopback-only HTTP listener for the PreToolUse + Stop hook callbacks from `claude`.
// Claude Code's HTTP hooks have SSRF protection — they only accept loopback URLs
// (127.0.0.1, ::1). The PWA + WSS surface remains on the Tailscale-bound HTTPS server
// in src/server.ts.

import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface HookServerOpts {
  port: number;
  daemonAuthSecret: string;
  onPreToolHook: (body: string) => Promise<string>;
  // Stop has no permission gate; a 204 is enough. Handler errors are logged but the
  // listener still returns 204 so claude's Stop loop doesn't stall on transient issues.
  onStopHook: (body: string) => Promise<void>;
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
    if (req.method !== 'POST' || (req.url !== '/hook/pretool' && req.url !== '/hook/stop')) {
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
    const url = req.url;
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', async () => {
      try {
        if (url === '/hook/pretool') {
          const result = await this.opts.onPreToolHook(body);
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(result);
        } else {
          await this.opts.onStopHook(body);
          res.statusCode = 204;
          res.end();
        }
      } catch (e) {
        console.error(`[hook-server] handler error (${url}):`, (e as Error).stack);
        if (url === '/hook/stop') {
          res.statusCode = 204;
          res.end();
        } else {
          res.statusCode = 500;
          res.end('error');
        }
      }
    });
    req.on('error', () => {
      res.statusCode = 400;
      res.end('bad request');
    });
  }
}
