import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { LoginError, failureReason, killGroup, stripAnsi, urlAfter } from './cli-login.js';

// Sign-in for the runtimes that aren't Claude. Claude's own flow (claude-login.ts) needs a pty
// and a pasted code because its callback is a hosted page; Codex's device-code flow and
// Cursor's browser flow both print a link and then poll for the result themselves, so neither
// needs a pty or any input — the daemon only has to show the link and wait for the CLI to exit.

export type LoginRuntime = 'codex' | 'cursor';

export function isLoginRuntime(v: unknown): v is LoginRuntime {
  return v === 'codex' || v === 'cursor';
}

const FLOW_TTL_MS = 15 * 60_000;
const PROMPT_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 8000;

const execFileAsync = promisify(execFile);

interface LoginSpec {
  args: string[];
  env: Record<string, string>;
  statusArgs: string[];
  // Pulls what the user must act on out of the CLI's output once it is all there; null while
  // the output is still partial.
  parsePrompt(text: string): { authUrl: string; code?: string } | null;
}

export const LOGIN_SPECS: Record<LoginRuntime, LoginSpec> = {
  codex: {
    args: ['login', '--device-auth'],
    env: {},
    statusArgs: ['login', 'status'],
    // The code is printed after the link, so waiting for it also means the link is whole.
    parsePrompt(text) {
      const authUrl = urlAfter(text, /Open this link/);
      const code = /one-time code[^\n]*\n\s*([A-Z0-9]{3,}-[A-Z0-9]{3,})/.exec(stripAnsi(text))?.[1];
      return authUrl && code ? { authUrl, code } : null;
    },
  },
  cursor: {
    args: ['login'],
    env: { NO_OPEN_BROWSER: '1' },
    statusArgs: ['status'],
    parsePrompt(text) {
      const authUrl = urlAfter(text, /navigate to this link:/);
      return authUrl ? { authUrl } : null;
    },
  },
};

export type RuntimeLoginStatus = 'awaiting' | 'done' | 'failed';

export interface RuntimeLoginFlow {
  id: string;
  runtime: LoginRuntime;
  authUrl: string;
  code?: string;
  status: RuntimeLoginStatus;
  startedAt: number;
  error?: string;
}

export interface RuntimeAccount {
  loggedIn: boolean;
  detail?: string;
  // Set when the CLI couldn't be asked at all; distinct from `loggedIn: false`, which is its answer.
  error?: string;
}

// Asks the CLI rather than reading its credential file: the file layout is the CLI's own business.
export async function readRuntimeAccount(runtime: LoginRuntime, bin: string): Promise<RuntimeAccount> {
  const spec = LOGIN_SPECS[runtime];
  try {
    const { stdout, stderr } = await execFileAsync(bin, spec.statusArgs, { encoding: 'utf8', timeout: STATUS_TIMEOUT_MS });
    return parseStatus(`${stdout}\n${stderr}`);
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string };
    // A signed-out CLI exits non-zero with a sentence saying so; anything else is a probe that failed.
    const said = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
    if (typeof err.code === 'number' && /not logged in|logged out|not signed in|not authenticated/i.test(said)) {
      return { loggedIn: false };
    }
    return { loggedIn: false, error: err.message };
  }
}

export function parseStatus(raw: string): RuntimeAccount {
  const text = stripAnsi(raw).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (text.some((l) => /not logged in|logged out|not signed in|not authenticated/i.test(l))) return { loggedIn: false };
  const line = text.find((l) => /logged in/i.test(l));
  if (!line) return { loggedIn: false, error: text[0] ?? 'the CLI printed no status' };
  const detail = [line.replace(/^[^\w]+/, ''), ...text.filter((l) => /^team:/i.test(l))].join(' · ');
  return { loggedIn: true, detail };
}

interface FlowRecord extends RuntimeLoginFlow {
  proc: ChildProcess;
  output: string;
  ttl?: NodeJS.Timeout;
}

function publicFlow(rec: FlowRecord): RuntimeLoginFlow {
  const { id, runtime, authUrl, code, status, startedAt, error } = rec;
  return { id, runtime, authUrl, status, startedAt, ...(code ? { code } : {}), ...(error ? { error } : {}) };
}

export class RuntimeLoginFlows {
  private readonly flows = new Map<LoginRuntime, FlowRecord>();

  constructor(
    private readonly resolveBin: (runtime: LoginRuntime) => string | null,
    private readonly onSignedIn?: (runtime: LoginRuntime) => void,
  ) {}

  current(runtime: LoginRuntime): RuntimeLoginFlow | null {
    const rec = this.flows.get(runtime);
    return rec ? publicFlow(rec) : null;
  }

  // One login per runtime at a time; a second caller gets the one in flight, which is how a
  // login begun on the desktop gets finished from a phone.
  async start(runtime: LoginRuntime): Promise<RuntimeLoginFlow> {
    const live = this.flows.get(runtime);
    if (live?.status === 'awaiting') return publicFlow(live);

    const bin = this.resolveBin(runtime);
    if (!bin) throw new LoginError(`${runtime} isn't installed on this machine`, 404);
    const spec = LOGIN_SPECS[runtime];
    const proc = spawn(bin, spec.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, ...spec.env },
    });
    const rec: FlowRecord = {
      id: randomUUID(), runtime, authUrl: '', status: 'awaiting', startedAt: Date.now(), proc, output: '',
    };

    const prompt = await new Promise<{ authUrl: string; code?: string } | null>((resolve) => {
      let settled = false;
      const finish = (p: { authUrl: string; code?: string } | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(p);
      };
      const timer = setTimeout(() => finish(null), PROMPT_TIMEOUT_MS);
      const onData = (chunk: Buffer): void => {
        rec.output += chunk.toString('utf8');
        const parsed = spec.parsePrompt(rec.output);
        if (parsed) finish(parsed);
      };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      proc.once('error', (e) => { rec.error = e.message; finish(null); });
      proc.once('exit', () => finish(null));
    });

    if (!prompt) {
      killGroup(proc);
      throw new LoginError(
        rec.error ?? failureReason(proc.exitCode, rec.output) ?? 'the login printed no sign-in link', 502);
    }

    rec.authUrl = prompt.authUrl;
    if (prompt.code) rec.code = prompt.code;
    rec.ttl = setTimeout(() => this.retire(rec, 'the sign-in link expired'), FLOW_TTL_MS);
    rec.ttl.unref();
    proc.once('exit', (exit) => this.settle(rec, exit));
    this.flows.set(runtime, rec);
    if (proc.exitCode !== null) this.settle(rec, proc.exitCode);
    return publicFlow(rec);
  }

  cancel(runtime: LoginRuntime): boolean {
    const rec = this.flows.get(runtime);
    if (!rec || rec.status !== 'awaiting') return false;
    this.retire(rec);
    this.flows.delete(runtime);
    return true;
  }

  private settle(rec: FlowRecord, exit: number | null): void {
    if (rec.status !== 'awaiting') return;
    if (rec.ttl) clearTimeout(rec.ttl);
    if (exit === 0) {
      rec.status = 'done';
      this.onSignedIn?.(rec.runtime);
    } else {
      rec.status = 'failed';
      rec.error = failureReason(exit, rec.output) ?? `the login exited ${exit}`;
    }
  }

  private retire(rec: FlowRecord, error?: string): void {
    if (rec.ttl) clearTimeout(rec.ttl);
    if (error && rec.status === 'awaiting') {
      rec.status = 'failed';
      rec.error = error;
    }
    killGroup(rec.proc);
  }
}
