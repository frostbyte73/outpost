import { execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolveClaudeBin } from '../session/claude-proc.js';
import {
  LoginError, awaitExit, failureReason, killGroup, spawnLoginPty, urlAfter,
} from './cli-login.js';

// Claude Code's OWN authentication, as opposed to the per-server MCP grants in mcp-login.ts.
// When this lapses nothing works: every spawned session dies at startup, including any session
// that could have repaired it — so the repair has to be daemon-side, driving the CLI directly.
//
// `claude auth login` prints an authorization URL and blocks on a paste prompt, so the same pty
// harness applies. It is materially easier than the MCP flow in one way: the redirect is a
// hosted claude.com callback rather than a localhost one, so the authorizing device lands on a
// page that actually loads and renders a code to copy, instead of a failed page whose address
// bar has to be salvaged.

const PTY_SCRIPT = fileURLToPath(new URL('./claude-login.expect', import.meta.url));
const AUTH_URL_TIMEOUT_MS = 30_000;
const EXCHANGE_TIMEOUT_MS = 60_000;
const FLOW_TTL_MS = 15 * 60_000;
const STATUS_TIMEOUT_MS = 5000;

const execFileAsync = promisify(execFile);

// Sidesteps the apostrophe in "didn't": whether the CLI emits U+0027 or U+2019 is not something
// to bet a match on, and the rest of the phrase is unambiguous in this output.
const AUTH_URL_MARKER = /open, visit:/;
const PASTE_PROMPT = /Paste code here/;

// The CLI's own words when the stored grant can no longer be renewed, matched rather than
// inferred from the exit code — that is the same 1 every other startup failure uses. This is
// the only announcement the daemon ever gets: it arrives on a dying session's stderr, so
// missing it means the lapse is discovered by every subsequent job failing for no stated
// reason.
const AUTH_FAILURE = /OAuth session expired|could not be refreshed|Please run \/login|Invalid API key/i;

export function isAuthFailure(text: string): boolean {
  return AUTH_FAILURE.test(text);
}

export type ClaudeLoginStatus = 'awaiting' | 'exchanging' | 'done' | 'failed';

export interface ClaudeLoginFlow {
  id: string;
  authUrl: string;
  status: ClaudeLoginStatus;
  startedAt: number;
  error?: string;
}

export interface ClaudeAccount {
  loggedIn: boolean;
  email?: string;
  orgName?: string;
  authMethod?: string;
  subscriptionType?: string;
  // Set when the CLI couldn't be asked at all. Distinct from `loggedIn: false`, which is the
  // CLI's own answer — reporting a timed-out probe as "signed out" would raise an alarm about
  // an account that is fine.
  error?: string;
}

// Asks the CLI rather than reading the keychain: the stored blob carries tokens and an expiry
// but no account identity, and the expiry is ~8 hours on a credential that refreshes itself, so
// it answers neither question the panel asks.
export async function readAccount(): Promise<ClaudeAccount> {
  try {
    const { stdout } = await execFileAsync(resolveClaudeBin(), ['auth', 'status', '--json'],
      { encoding: 'utf8', timeout: STATUS_TIMEOUT_MS });
    const parsed = JSON.parse(stdout) as ClaudeAccount;
    return { ...parsed, loggedIn: !!parsed.loggedIn };
  } catch (e) {
    return { loggedIn: false, error: (e as Error).message };
  }
}

// Vets what came back from the authorizing device and returns the line to hand the CLI. The
// callback page renders `<code>#<state>`, but a phone paste is just as likely to be the whole
// address bar, so both are accepted and only a crossed flow is refused.
export function parseCode(authUrl: string, pasted: string): string {
  const text = pasted.trim();
  if (!text) throw new LoginError('paste the code from the authorization page', 400);

  const want = stateOf(authUrl);
  if (/^https?:\/\//i.test(text)) {
    let parsed: URL;
    try {
      parsed = new URL(text);
    } catch {
      throw new LoginError('that looks like a URL but could not be read — paste just the code instead', 400);
    }
    const code = parsed.searchParams.get('code');
    if (!code) {
      const refused = parsed.searchParams.get('error');
      throw new LoginError(refused
        ? `the authorization was refused: ${refused}`
        : 'that URL carries no ?code= — copy the code the authorization page displayed', 400);
    }
    const got = parsed.searchParams.get('state');
    assertState(want, got);
    // Recombined into the shape the CLI's prompt expects; pasting a URL is the one case where
    // the two halves arrive separated.
    return got ? `${code}#${got}` : code;
  }

  if (/\s/.test(text)) {
    throw new LoginError('that does not look like an authorization code — copy just the code the page displayed', 400);
  }
  // Passed through verbatim: a `code#state` paste is already exactly what the CLI wants, and
  // a bare code is handed over as-is rather than having a state invented for it.
  const [, got] = text.split('#');
  assertState(want, got);
  return text;
}

function stateOf(authUrl: string): string | null {
  try {
    return new URL(authUrl).searchParams.get('state');
  } catch {
    return null;
  }
}

// Catches a paste crossed between two flows — otherwise a confusing CLI-side reject.
function assertState(want: string | null, got: string | null | undefined): void {
  if (want && got && want !== got) {
    throw new LoginError('that code belongs to a different login flow', 400);
  }
}

function publicFlow(rec: FlowRecord): ClaudeLoginFlow {
  const { id, authUrl, status, startedAt, error } = rec;
  return { id, authUrl, status, startedAt, ...(error ? { error } : {}) };
}

interface FlowRecord extends ClaudeLoginFlow {
  proc: ChildProcess;
  output: string;
  ttl?: NodeJS.Timeout;
}

export class ClaudeLoginFlows {
  private flow: FlowRecord | null = null;
  private failedAt: number | null = null;

  // onAuthorized fires after a successful exchange so sessions holding the dead credential can
  // be recycled; see SessionManager.reloadForReauth.
  constructor(private readonly onAuthorized?: () => void) {}

  current(): ClaudeLoginFlow | null {
    return this.flow ? publicFlow(this.flow) : null;
  }

  // Recorded when a spawned session dies complaining about authentication, and cleared by a
  // successful login. It is what lets the PWA show the lapse with no session attached — the
  // stderr frame it rides in on only reaches clients that happen to be watching that session.
  noteFailure(): void {
    this.failedAt = Date.now();
  }

  failedSince(): number | null {
    return this.failedAt;
  }

  // Any session reaching system/init authenticated successfully, which is the only evidence
  // the daemon gets that a repair made OUTSIDE Outpost — `claude auth login` run on the Mac
  // itself — actually landed. Without it the warn-dot would stay lit until someone
  // re-authorized through this panel specifically.
  clearFailure(): void {
    this.failedAt = null;
  }

  // Unlike the MCP flow there is nothing to key by: one account, one login at a time. An
  // in-flight flow is returned as-is rather than raced, which is also how a login begun on the
  // desktop gets finished on a phone.
  async start(): Promise<ClaudeLoginFlow> {
    if (this.flow?.status === 'awaiting') return publicFlow(this.flow);

    const proc = spawnLoginPty(PTY_SCRIPT, [resolveClaudeBin()]);
    const rec: FlowRecord = {
      id: randomUUID(), authUrl: '', status: 'awaiting', startedAt: Date.now(), proc, output: '',
    };

    const authUrl = await new Promise<string | null>((resolve) => {
      let done = false;
      const finish = (url: string | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(url);
      };
      const timer = setTimeout(() => finish(null), AUTH_URL_TIMEOUT_MS);
      // Waits for the paste prompt rather than the first chunk carrying a URL: the prompt is
      // the CLI's own marker that everything before it is flushed, and a URL read mid-stream
      // is a truncated one that fails on the phone with nothing to explain why.
      const onData = (chunk: Buffer): void => {
        rec.output += chunk.toString('utf8');
        if (!PASTE_PROMPT.test(rec.output)) return;
        const url = urlAfter(rec.output, AUTH_URL_MARKER);
        if (url) finish(url);
      };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      proc.once('error', (e) => { rec.error = e.message; finish(null); });
      proc.once('exit', () => finish(null));
    });

    if (!authUrl) {
      killGroup(proc);
      throw new LoginError(
        rec.error ?? failureReason(proc.exitCode, rec.output) ?? 'the login printed no authorization URL', 502);
    }

    rec.authUrl = authUrl;
    rec.ttl = setTimeout(() => this.retire(rec), FLOW_TTL_MS);
    rec.ttl.unref();
    this.flow = rec;
    return publicFlow(rec);
  }

  // Feeds the pasted code to the waiting CLI and settles the flow on its exit code.
  async submitCode(id: string, code: string): Promise<ClaudeLoginFlow> {
    const rec = this.flow;
    if (!rec || rec.id !== id) throw new LoginError('no such login flow — it may have expired', 404);
    if (rec.status !== 'awaiting') throw new LoginError(`this flow is already ${rec.status}`, 409);

    const line = parseCode(rec.authUrl, code);

    rec.status = 'exchanging';
    const mark = rec.output.length;
    rec.proc.stdin?.write(`${line}\n`);

    const exit = await awaitExit(rec.proc, EXCHANGE_TIMEOUT_MS);
    if (exit === 0) {
      rec.status = 'done';
      this.failedAt = null;
      this.onAuthorized?.();
    } else {
      rec.status = 'failed';
      rec.error = failureReason(exit, rec.output.slice(mark))
        ?? (exit === null ? 'the login timed out completing the exchange' : `the login exited ${exit}`);
    }
    const settled = publicFlow(rec);
    this.retire(rec);
    return settled;
  }

  cancel(id: string): boolean {
    if (!this.flow || this.flow.id !== id) return false;
    this.retire(this.flow);
    return true;
  }

  private retire(rec: FlowRecord): void {
    if (rec.ttl) clearTimeout(rec.ttl);
    killGroup(rec.proc);
    if (this.flow === rec) this.flow = null;
  }
}
