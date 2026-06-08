import { spawn, type ChildProcess } from 'node:child_process';
import { LineParser } from './stream-json.js';

export interface ClaudeProcOpts {
  sessionId: string;
  // 'new' uses --session-id to start a fresh conversation under this UUID;
  // 'resume' uses --resume to continue an existing one.
  mode: 'new' | 'resume';
  settingsPath: string;
  // Claude stores sessions under ~/.claude/projects/<sanitized-cwd>/, so the cwd at spawn
  // time determines where sessions land on disk. Pinning a consistent cwd ensures the
  // daemon's SessionStore (which reads from a single dir) sees every session it spawned.
  cwd: string;
  env: Record<string, string>;
  onMessage: (msg: unknown) => void;
  onError: (msg: string) => void;
  onExit: (code: number | null) => void;
}

export class ClaudeProc {
  private readonly proc: ChildProcess;
  private readonly parser = new LineParser();
  private exited = false;

  constructor(opts: ClaudeProcOpts) {
    this.parser.onLine = opts.onMessage;
    this.parser.onError = (raw, err) => opts.onError(`malformed line from claude: ${raw.slice(0, 200)} (${err.message})`);

    const sessionArgs = opts.mode === 'resume'
      ? ['--resume', opts.sessionId]
      : ['--session-id', opts.sessionId];

    this.proc = spawn(
      'claude',
      [
        '--print',
        '--verbose',
        '--input-format=stream-json',
        '--output-format=stream-json',
        '--include-hook-events',
        '--include-partial-messages',
        '--settings', opts.settingsPath,
        ...sessionArgs,
      ],
      {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    this.proc.stdout?.setEncoding('utf8');
    this.proc.stdout?.on('data', (chunk: string) => this.parser.write(chunk));
    this.proc.stderr?.setEncoding('utf8');
    this.proc.stderr?.on('data', (chunk: string) => opts.onError(`[claude stderr] ${chunk}`));
    this.proc.on('exit', (code) => {
      this.exited = true;
      opts.onExit(code);
    });
  }

  send(message: unknown): void {
    if (this.exited) throw new Error('claude proc has exited');
    this.proc.stdin?.write(JSON.stringify(message) + '\n');
  }

  async kill(): Promise<void> {
    if (this.exited) return;
    this.proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (!this.exited) this.proc.kill('SIGKILL');
      }, 5000);
      this.proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}
