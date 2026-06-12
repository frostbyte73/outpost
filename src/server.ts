import { createServer, type Server as HttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import { IncomingMessage, ServerResponse } from 'node:http';

export interface ServerOpts {
  certPath: string;
  keyPath: string;
  bindAddress: string;
  port: number;
  // Ping interval (ms) for the server-initiated WS heartbeat. 0 disables.
  // Reap policy: a client that didn't pong since the previous tick is terminated.
  // Default 30_000 → up to 60s to detect a silently dead connection (iOS background, etc.).
  heartbeatMs?: number;
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
  private heartbeatTimer?: NodeJS.Timeout;

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

    // Heartbeat: every connection starts alive. The 'pong' listener flips isAlive back
    // to true each round-trip; the timer below flips it to false right before sending
    // the next ping. Any client that didn't pong since the last tick is terminated.
    this.wss.on('connection', (ws) => {
      (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
      ws.on('pong', () => { (ws as WebSocket & { isAlive?: boolean }).isAlive = true; });
    });

    const interval = opts.heartbeatMs ?? 30_000;
    if (interval > 0) {
      this.heartbeatTimer = setInterval(() => {
        for (const ws of this.wss.clients) {
          const w = ws as WebSocket & { isAlive?: boolean };
          if (w.isAlive === false) {
            w.terminate();
            continue;
          }
          w.isAlive = false;
          try { w.ping(); } catch { /* socket already closing */ }
        }
      }, interval);
      // Don't pin the event loop open for the heartbeat alone.
      this.heartbeatTimer.unref?.();
    }
  }

  close(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    return new Promise((resolve) => this.https.close(() => resolve()));
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
