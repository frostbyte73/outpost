import { createServer, type Server as HttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { IncomingMessage, ServerResponse } from 'node:http';

export interface ServerOpts {
  certPath: string;
  keyPath: string;
  bindAddress: string;
  port: number;
}

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

interface RouteEntry {
  method: string;
  pattern: RegExp;
  handler: RouteHandler;
}

export class Server {
  private readonly https: HttpsServer;
  private readonly wss: WebSocketServer;
  private routes: RouteEntry[] = [];

  constructor(private opts: ServerOpts) {
    this.https = createServer(
      {
        cert: readFileSync(opts.certPath),
        key: readFileSync(opts.keyPath),
      },
      (req, res) => this.handle(req, res),
    );
    this.wss = new WebSocketServer({ noServer: true });
    this.https.on('upgrade', (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });
  }

  route(method: string, path: string, h: RouteHandler): void {
    // Translate path patterns with `:param` placeholders into an anchored regex so that
    // routes like `/api/sessions/:id/messages` work without hand-rolled URL parsing.
    const escaped = path.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
    const withParams = escaped.replace(/:[a-zA-Z_]\w*/g, '[\\w-]+');
    const pattern = new RegExp(`^${withParams}$`);
    this.routes.push({ method, pattern, handler: h });
  }

  onWebSocket(handler: Parameters<WebSocketServer['on']>[1]): void {
    this.wss.on('connection', handler);
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.https.listen(this.opts.port, this.opts.bindAddress, () => resolve());
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0]!;
    const method = req.method ?? 'GET';
    const match = this.routes.find((r) => r.method === method && r.pattern.test(path));
    if (match) {
      try {
        await match.handler(req, res);
      } catch (e) {
        console.error('[server] handler error:', (e as Error).stack);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end('error');
        }
      }
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  }
}
