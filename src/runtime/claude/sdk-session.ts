import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export interface ClaudeSdkSessionOpts {
  options: Options;
  onMessage: (msg: SDKMessage) => void;
  onError: (msg: string) => void;
  onExit: (code: number | null) => void;
}

// One streaming-input query() held open across turns; interrupt ends it.
export class ClaudeSdkSession {
  private readonly pending: SDKUserMessage[] = [];
  private wake?: () => void;
  private ended = false;
  private closing = false;
  private exited = false;
  private readonly q?: Query;
  private readonly done: Promise<void>;

  constructor(private readonly opts: ClaudeSdkSessionOpts) {
    try {
      this.q = query({ prompt: this.messages(), options: opts.options });
    } catch (e) {
      // Reported after start() returns: the caller registers the session only once start() has.
      this.ended = true;
      this.done = Promise.resolve();
      queueMicrotask(() => {
        opts.onError(`failed to start claude: ${(e as Error).message}`);
        this.exit(null);
      });
      return;
    }
    this.done = this.pump(this.q);
  }

  send(msg: SDKUserMessage): void {
    if (this.ended) throw new Error('claude session has exited');
    this.pending.push(msg);
    this.wake?.();
  }

  interrupt(): void {
    if (this.ended || !this.q) return;
    this.q.interrupt().catch(() => { /* the kill below ends it either way */ });
    setTimeout(() => void this.kill(), 1000);
  }

  async kill(): Promise<void> {
    if (!this.exited) this.closing = true;
    this.endInput();
    this.q?.close();
    await this.done;
  }

  private endInput(): void {
    this.ended = true;
    this.wake?.();
  }

  private async *messages(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const next = this.pending.shift();
      if (next) { yield next; continue; }
      if (this.ended) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = undefined;
    }
  }

  private async pump(q: Query): Promise<void> {
    try {
      for await (const msg of q) this.opts.onMessage(msg);
      this.exit(this.closing ? null : 0);
    } catch (e) {
      if (!this.closing) this.opts.onError(`claude session failed: ${(e as Error).message}`);
      this.exit(null);
    } finally {
      this.endInput();
    }
  }

  private exit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.opts.onExit(code);
  }
}
