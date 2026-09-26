// `!cmd` from the PWA composer — the user running a shell command themselves, not the
// model running one. Nothing here consults the allowlist or the approval queue: those gate
// what Claude may do, and this is the user's own hand. It is also the only way to reach the
// things Claude Code refuses outright (its own `~/.claude/**` deny rules, which a
// PreToolUse `allow` doesn't override).
//
// Output is queued rather than sent: in stream-json input mode every user message we hand
// the subprocess starts a turn, so posting the result immediately would make Claude answer
// an `ls`. The TUI queues `!` output into the next real user message; drain() is that.
import { spawn } from 'node:child_process';

const TIMEOUT_MS = 120_000;
// Per stream. The blocks ride into the model's context on the next turn, so an unbounded
// `cat` of a large file would eat it.
const MAX_STREAM_CHARS = 30_000;

export interface ShellRun {
  command: string;
  stdout: string;
  stderr: string;
}

// The wire shape Claude Code's own TUI writes into the transcript for a `!` command.
// Matching it exactly is what lets session-store.ts read back a `!` run that happened in
// the terminal the same way it reads one that happened here.
export function bashBlocks(run: ShellRun): string {
  return `<bash-input>${run.command}</bash-input>`
    + `<bash-stdout>${run.stdout}</bash-stdout>`
    + `<bash-stderr>${run.stderr}</bash-stderr>`;
}

const BASH_BLOCK_RE = /<bash-input>([\s\S]*?)<\/bash-input>\s*(?:<bash-stdout>([\s\S]*?)<\/bash-stdout>)?\s*(?:<bash-stderr>([\s\S]*?)<\/bash-stderr>)?/g;

// Split a user message into the `!` runs prepended to it and whatever the user actually
// typed. Both halves matter: the runs render as their own tiles, and dropping the message
// wholesale (which is what the old `<bash-input>` system-injection filter did) would take
// the user's text with it.
export function splitBashBlocks(text: string): { runs: ShellRun[]; rest: string } {
  if (!text.includes('<bash-input>')) return { runs: [], rest: text };
  const runs: ShellRun[] = [];
  const rest = text.replace(BASH_BLOCK_RE, (_m, cmd: string, out?: string, err?: string) => {
    runs.push({ command: cmd, stdout: out ?? '', stderr: err ?? '' });
    return '';
  });
  return { runs, rest: rest.trim() };
}

function cap(s: string): string {
  if (s.length <= MAX_STREAM_CHARS) return s;
  return `${s.slice(0, MAX_STREAM_CHARS)}\n… truncated, ${s.length - MAX_STREAM_CHARS} more characters`;
}

export function runShellCommand(command: string, cwd: string): Promise<ShellRun> {
  return new Promise((resolve) => {
    // Login shell so the command sees the PATH the user would get in a terminal — launchd
    // strips the shell environment from the daemon, so a bare `zsh -c` misses homebrew.
    const proc = spawn(process.env.SHELL || '/bin/zsh', ['-lc', command], {
      cwd,
      timeout: TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (c: string) => { stdout += c; });
    proc.stderr.on('data', (c: string) => { stderr += c; });
    proc.on('error', (e) => resolve({ command, stdout: '', stderr: `failed to run: ${e.message}` }));
    proc.on('close', (code, signal) => {
      const note = signal === 'SIGKILL' ? `\n… killed after ${TIMEOUT_MS / 1000}s` : '';
      const exit = code !== null && code !== 0 ? `\nexit ${code}` : '';
      resolve({ command, stdout: cap(stdout), stderr: cap(stderr) + note + exit });
    });
  });
}

export interface SessionShellDeps {
  cwdFor: (sessionId: string) => string | undefined;
  broadcast: (sessionId: string, message: unknown) => void;
  // Read per call, not captured once: the user can flip the preference mid-session and a
  // cached value would keep running commands after they turned it off.
  enabled: () => boolean;
}

export class SessionShell {
  private pending = new Map<string, string[]>();

  constructor(private readonly deps: SessionShellDeps) {}

  // Run `command` in the session's cwd, push the result to attached clients, and hold the
  // transcript blocks for the next user message. `execId` is the client's handle on the
  // tile it already rendered optimistically.
  async run(sessionId: string, execId: string, command: string): Promise<void> {
    // Enforced here rather than only in the composer: the frame is reachable from any client
    // on the tailnet, and a preference that merely hides a button grants nothing.
    if (!this.deps.enabled()) {
      this.deps.broadcast(sessionId, {
        type: 'shell_result',
        execId,
        command,
        stdout: '',
        stderr: 'Shell commands are off. Turn them on in Settings › Permissions.',
      });
      return;
    }
    const cwd = this.deps.cwdFor(sessionId);
    const result = cwd
      ? await runShellCommand(command, cwd)
      : { command, stdout: '', stderr: 'no working directory known for this session' };
    if (cwd) {
      const queued = this.pending.get(sessionId) ?? [];
      queued.push(bashBlocks(result));
      this.pending.set(sessionId, queued);
    }
    this.deps.broadcast(sessionId, {
      type: 'shell_result',
      execId,
      command,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }

  drain(sessionId: string): string {
    const queued = this.pending.get(sessionId);
    if (!queued?.length) return '';
    this.pending.delete(sessionId);
    return queued.join('');
  }

  // Put drained blocks back after a send that threw — the session went inactive between the
  // drain and the write, and the PWA will retry the same message on the reconnect.
  restore(sessionId: string, blocks: string): void {
    if (!blocks) return;
    const queued = this.pending.get(sessionId) ?? [];
    queued.unshift(blocks);
    this.pending.set(sessionId, queued);
  }
}
