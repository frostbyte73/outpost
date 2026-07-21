import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import { IncomingMessage, ServerResponse } from 'node:http';

export interface HttpsListenerOpts {
  certPath: string;
  keyPath: string;
  bindAddress: string;
  httpsPort: number;
}

export interface ServerOpts {
  // Loopback listener hardcodes 127.0.0.1; no bind override on purpose.
  httpPort: number | null;
  https?: HttpsListenerOpts;
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
  private readonly http: HttpServer | null;
  private readonly https: HttpsServer | null;
  private readonly wss: WebSocketServer;
  private routes: RouteEntry[] = [];
  private fallbackMethod: string | null = null;
  private fallbackHandler: RouteHandler | null = null;
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(private opts: ServerOpts) {
    if (opts.httpPort === null && !opts.https) {
      throw new Error('Server: at least one listener (httpPort or https) must be configured');
    }

    const handler = (req: IncomingMessage, res: ServerResponse) => this.handle(req, res);
    this.http = opts.httpPort === null ? null : createHttpServer(handler);
    this.https = opts.https
      ? createHttpsServer(
          { cert: readFileSync(opts.https.certPath), key: readFileSync(opts.https.keyPath) },
          handler,
        )
      : null;

    // One WebSocketServer shared across both listeners.
    this.wss = new WebSocketServer({ noServer: true });
    const upgrade = (req: IncomingMessage, socket: import('node:net').Socket, head: Buffer) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    };
    if (this.http) this.http.on('upgrade', upgrade);
    if (this.https) this.https.on('upgrade', upgrade);

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
    const closes: Promise<void>[] = [];
    if (this.http) closes.push(new Promise((r) => this.http!.close(() => r())));
    if (this.https) closes.push(new Promise((r) => this.https!.close(() => r())));
    return Promise.all(closes).then(() => undefined);
  }

  route(method: string, path: string, h: RouteHandler): void {
    // Translate path patterns with `:param` placeholders into an anchored regex so that
    // routes like `/api/sessions/:id/messages` work without hand-rolled URL parsing.
    const escaped = path.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
    const withParams = escaped.replace(/:[a-zA-Z_]\w*/g, '[^/]+');
    const pattern = new RegExp(`^${withParams}$`);
    this.routes.push({ method, pattern, handler: h });
  }

  // Called when no explicit route matches. Only one fallback is supported; last call wins.
  routeFallback(method: string, h: RouteHandler): void {
    this.fallbackMethod = method;
    this.fallbackHandler = h;
  }

  onWebSocket(handler: Parameters<WebSocketServer['on']>[1]): void {
    this.wss.on('connection', handler);
  }

  listen(): Promise<void> {
    const listens: Promise<void>[] = [];
    if (this.http) {
      const port = this.opts.httpPort!;
      listens.push(new Promise((r) => this.http!.listen(port, '127.0.0.1', () => r())));
    }
    if (this.https) {
      const { httpsPort, bindAddress } = this.opts.https!;
      listens.push(new Promise((r) => this.https!.listen(httpsPort, bindAddress, () => r())));
    }
    return Promise.all(listens).then(() => undefined);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0]!;
    const method = req.method ?? 'GET';
    const match = this.routes.find((r) => r.method === method && r.pattern.test(path));
    const handler = match?.handler ?? (this.fallbackMethod === method ? this.fallbackHandler : null);
    if (handler) {
      try {
        await handler(req, res);
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
