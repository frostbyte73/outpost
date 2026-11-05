import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { LineParser } from '../../session/stream-json.js';

export interface AcpConnectionOpts {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  onNotification: (method: string, params: unknown) => void;
  // A thrown error becomes the JSON-RPC error reply.
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  onStderr: (s: string) => void;
  onExit: (code: number | null) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
}

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

const KILL_GRACE_MS = 5_000;

// One ACP agent process speaking newline-delimited JSON-RPC on stdio, in both directions.
export class AcpConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private exited = false;

  constructor(private readonly opts: AcpConnectionOpts) {
    this.child = spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const parser = new LineParser();
    parser.onLine = (obj) => this.onMessage(obj as RpcMessage);
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (d: string) => parser.write(d));
    this.child.stderr.on('data', (d: string) => opts.onStderr(d));
    this.child.on('error', (e) => {
      opts.onStderr(`[acp spawn] ${e.message}\n`);
      // A process that never started emits no 'exit', which would leave every waiter hanging.
      if (this.child.pid === undefined) this.markExited(null);
    });
    // A write racing the agent's exit raises EPIPE here; unheard, it would be an uncaught error in the daemon.
    this.child.stdin.on('error', (e) => opts.onStderr(`[acp stdin] ${e.message}\n`));
    this.child.on('exit', (code) => this.markExited(code));
  }

  request<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.exited) return Promise.reject(new Error('acp agent is not running'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { resolve: resolve as (v: unknown) => void, reject };
      if (Number.isFinite(timeoutMs)) {
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`acp ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, p);
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  kill(): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const force = setTimeout(() => this.child.kill('SIGKILL'), KILL_GRACE_MS);
      this.child.once('exit', () => { clearTimeout(force); resolve(); });
      this.child.kill('SIGTERM');
    });
  }

  private markExited(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`acp agent exited (${code})`));
    }
    this.pending.clear();
    this.opts.onExit(code);
  }

  private write(msg: object): void {
    if (!this.exited) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  }

  private onMessage(msg: RpcMessage): void {
    if (msg.method && msg.id !== undefined) return void this.answer(msg.id, msg.method, msg.params);
    if (msg.method) return this.opts.onNotification(msg.method, msg.params);
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(`acp: ${msg.error.message}`));
    else p.resolve(msg.result);
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      this.write({ id, result: await this.opts.onRequest(method, params) });
    } catch (e) {
      this.write({ id, error: { code: -32603, message: (e as Error).message } });
    }
  }
}
