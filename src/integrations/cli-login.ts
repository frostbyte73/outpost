import { spawn, type ChildProcess } from 'node:child_process';

// The half of driving `claude` through an OAuth login on a pty that the MCP flow
// (mcp-login.ts) and the account flow (claude-login.ts) do identically. Both spawn the CLI
// under expect(1), scrape an authorization URL out of its pty stream, block on a prompt, and
// settle on its exit code — only the subcommand, the markers, and what gets pasted back
// differ. See mcp-login.expect for why a pty is required and neither a pipe nor script(1) can
// stand in for it.

const EXPECT = '/usr/bin/expect';

export class LoginError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = 'LoginError';
  }
}

// The CLI wraps URLs in an OSC-8 hyperlink (ESC]8;;<url>ESC\<url>ESC]8;;BEL), so the pty
// stream carries each one twice; stripping escapes leaves the visible copy.
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(raw: string): string {
  return raw.replace(OSC, '').replace(CSI, '');
}

// Pulls the URL following a marker the CLI prints, anchored on that label rather than on
// anything about the URL's shape — the flavours share nothing (a PKCE URL with a localhost
// redirect, a claude.ai start-auth URL, a claude.com account URL), so matching on query params
// rejects most of them.
//
// The trailing-boundary lookahead is what makes this safe against a partially-received pty
// buffer: a URL running to the end of the buffer may be half a URL, and half of one is
// indistinguishable from a whole one by content.
export function urlAfter(raw: string, marker: RegExp): string | null {
  const text = stripAnsi(raw);
  const found = marker.exec(text);
  if (!found) return null;
  const url = /https?:\/\/[^\s"'<>]+(?=[\s"'<>])/.exec(text.slice(found.index + found[0].length));
  return url ? url[0] : null;
}

// Surfaces the CLI's own last word on a failure rather than a message of our invention — it is
// the only explanation of WHY an exchange was rejected that anyone gets.
export function lastLine(raw: string): string | null {
  const lines = stripAnsi(raw).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? null;
}

// The expect wrappers' own exits, kept distinct from the CLI's so a harness failure never
// reads to the user as a refused authorization.
const PTY_EXIT_REASONS: Record<number, string> = {
  90: 'the login never reached its paste prompt',
  91: 'the login exited before asking for anything to paste',
  92: 'the login was closed before an authorization arrived',
};

export function failureReason(code: number | null, output: string): string | null {
  if (code !== null && PTY_EXIT_REASONS[code]) return PTY_EXIT_REASONS[code]!;
  return lastLine(output);
}

export function spawnLoginPty(scriptPath: string, args: string[]): ChildProcess {
  return spawn(EXPECT, ['-f', scriptPath, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    // Forced rather than inherited so the output shape can't depend on whether launchd
    // happened to hand the daemon a TERM.
    env: { ...process.env, TERM: 'xterm-256color' },
  });
}

export function killGroup(proc: ChildProcess): void {
  if (proc.pid === undefined || proc.exitCode !== null) return;
  try {
    process.kill(-proc.pid, 'SIGKILL'); // negative pid: the claude child outlives a kill aimed at expect alone
  } catch {
    // already reaped
  }
}

export function awaitExit(proc: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (proc.exitCode !== null) return Promise.resolve(proc.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    proc.once('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
}
