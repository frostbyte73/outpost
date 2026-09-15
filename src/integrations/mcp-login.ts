import { type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveClaudeBin } from '../session/claude-proc.js';
import {
  LoginError, awaitExit, failureReason, killGroup, lastLine, spawnLoginPty, stripAnsi, urlAfter,
} from './cli-login.js';

// Cross-device MCP OAuth: `claude mcp login --no-browser` prints an authorization URL and then
// blocks reading the redirect URL back. Both halves are load-bearing. The URL is what the PWA
// hands to a phone, and the blocking read is why the child needs a pty — see mcp-login.expect
// for why neither a pipe nor script(1) can stand in.
//
// The user authorizes on whatever device they like, lands on a localhost callback that device
// can't serve, and pastes the address bar back. Nothing here automates a consent screen: the
// authorization is ordinary and human, only the transport of the result is ours.

const PTY_SCRIPT = fileURLToPath(new URL('./mcp-login.expect', import.meta.url));
const AUTH_URL_TIMEOUT_MS = 30_000;
const EXCHANGE_TIMEOUT_MS = 60_000;
// An unfinished flow holds a pty and a pending PKCE exchange whose authorization code expires
// long before this; sweeping is what keeps a walked-away-from login from leaking either.
const FLOW_TTL_MS = 15 * 60_000;

export type McpLoginStatus = 'awaiting' | 'exchanging' | 'done' | 'failed' | 'handoff';

// Two completion shapes, decided by the CLI and not by us:
//   'paste'   — a configured server. The CLI holds a pty open on its paste prompt and does the
//               PKCE exchange itself, so the redirect URL has to come back to it.
//   'handoff' — a claude.ai connector. The CLI prints a claude.ai start-auth URL and exits;
//               authorizing there lands the grant on the account, and Claude Code picks it up
//               on its next start. There is nothing to paste and nothing to keep alive.
export type McpLoginKind = 'paste' | 'handoff';

export interface McpLoginFlow {
  id: string;
  server: string;
  authUrl: string;
  kind: McpLoginKind;
  status: McpLoginStatus;
  startedAt: number;
  error?: string;
}

interface FlowRecord extends McpLoginFlow {
  proc: ChildProcess;
  output: string;
  ttl?: NodeJS.Timeout;
}

const PASTE_PROMPT = /paste the redirect URL/;
const AUTH_URL_MARKER = /Visit this URL to authorize:/;

export function extractAuthUrl(raw: string): string | null {
  return urlAfter(raw, AUTH_URL_MARKER);
}

function paramOf(url: string, key: string): string | null {
  try {
    return new URL(url).searchParams.get(key);
  } catch {
    return null;
  }
}

// Vets a pasted redirect against the flow that issued it, returning the URL to hand the CLI.
// Rejecting here rather than letting the CLI do it is what turns "invalid_grant" into a
// sentence that says which part of the paste was wrong.
export function parseRedirect(authUrl: string, redirectUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(redirectUrl.trim());
  } catch {
    throw new LoginError('that is not a URL — paste the whole address, starting with http', 400);
  }
  if (!parsed.searchParams.get('code')) {
    const refused = parsed.searchParams.get('error');
    throw new LoginError(refused
      ? `the authorization was refused: ${refused}`
      : 'that URL carries no ?code= — copy the address bar of the page the consent screen redirected to, even though it failed to load', 400);
  }
  // Catches a paste crossed between two flows, otherwise a confusing CLI-side reject.
  const want = paramOf(authUrl, 'state');
  const got = parsed.searchParams.get('state');
  if (want && got && want !== got) {
    throw new LoginError('that redirect URL belongs to a different login flow', 400);
  }
  return parsed.toString();
}

function publicFlow(rec: FlowRecord): McpLoginFlow {
  const { id, server, authUrl, kind, status, startedAt, error } = rec;
  return { id, server, authUrl, kind, status, startedAt, ...(error ? { error } : {}) };
}

export class McpLoginFlows {
  private flows = new Map<string, FlowRecord>();

  // Called after an exchange lands so sessions holding the previous credential can pick the
  // new one up; see SessionManager.reloadForReauth.
  constructor(private readonly onAuthorized?: () => void) {}

  list(): McpLoginFlow[] {
    return [...this.flows.values()].map(publicFlow);
  }

  // Starts a login for `server`, resolving once the CLI has printed its authorization URL. An
  // already-awaiting flow for the same server is returned as-is rather than raced against it:
  // two pty children bidding for one keychain entry would clobber each other's PKCE state, and
  // rejoining is the case that matters anyway — begun on the desktop, finished on a phone.
  async start(server: string): Promise<McpLoginFlow> {
    const rejoin = [...this.flows.values()].find((f) => f.server === server && f.status === 'awaiting');
    if (rejoin) return publicFlow(rejoin);
    // A handoff holds no live process, so re-tapping it is free — but the stale record would
    // pile up alongside the new one and leave the panel two links to choose between.
    for (const f of [...this.flows.values()]) {
      if (f.server === server && f.status === 'handoff') this.retire(f);
    }

    const proc = spawnLoginPty(PTY_SCRIPT, [resolveClaudeBin(), server]);

    const rec: FlowRecord = {
      id: randomUUID(), server, authUrl: '', kind: 'paste', status: 'awaiting',
      startedAt: Date.now(), proc, output: '',
    };

    const settled = await new Promise<{ url: string | null; kind: McpLoginKind }>((resolve) => {
      let done = false;
      const finish = (url: string | null, kind: McpLoginKind): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ url, kind });
      };
      const timer = setTimeout(() => finish(null, 'paste'), AUTH_URL_TIMEOUT_MS);
      // Stays attached past the URL so a later failure still has the CLI's output to quote.
      // The paste prompt is both the kind discriminator and the CLI's own marker that
      // everything before it is fully flushed — resolving on the first chunk that merely
      // CONTAINS a URL yields a truncated one, which fails on the phone with nothing to
      // explain why. A connector never prints this prompt; it exits instead.
      const onData = (chunk: Buffer): void => {
        rec.output += chunk.toString('utf8');
        if (!PASTE_PROMPT.test(rec.output)) return;
        const url = extractAuthUrl(rec.output);
        if (url) finish(url, 'paste');
      };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      proc.once('error', (e) => { rec.error = e.message; finish(null, 'paste'); });
      proc.once('exit', () => finish(extractAuthUrl(rec.output), 'handoff'));
    });
    const authUrl = settled.url;
    rec.kind = settled.kind;

    if (!authUrl) {
      killGroup(proc);
      // The CLI is the authority on which servers exist — including the 30-odd claude.ai
      // connectors no local config lists — so its own refusal is what answers 404 here.
      if (/No MCP server named/.test(stripAnsi(rec.output))) {
        throw new LoginError(lastLine(rec.output) ?? `no MCP server named "${server}"`, 404);
      }
      throw new LoginError(
        rec.error ?? failureReason(proc.exitCode, rec.output) ?? 'the login printed no authorization URL', 502);
    }

    rec.authUrl = authUrl;
    // A handoff has already exited and owns no pending exchange; it's retained only so the
    // link survives a repaint or a second device picking the flow up.
    if (rec.kind === 'handoff') rec.status = 'handoff';
    rec.ttl = setTimeout(() => { killGroup(rec.proc); this.flows.delete(rec.id); }, FLOW_TTL_MS);
    rec.ttl.unref();
    this.flows.set(rec.id, rec);
    return publicFlow(rec);
  }

  // Feeds a pasted redirect URL to the waiting CLI and settles the flow on its exit code.
  async submitRedirect(id: string, redirectUrl: string): Promise<McpLoginFlow> {
    const rec = this.flows.get(id);
    if (!rec) throw new LoginError('no such login flow — it may have expired', 404);
    if (rec.kind === 'handoff') {
      throw new LoginError(
        'this connector is authorized on claude.ai — there is nothing to paste back; it becomes available on the next session', 409);
    }
    if (rec.status !== 'awaiting') throw new LoginError(`this flow is already ${rec.status}`, 409);

    const redirect = parseRedirect(rec.authUrl, redirectUrl);

    rec.status = 'exchanging';
    const mark = rec.output.length;
    rec.proc.stdin?.write(`${redirect}\n`);

    const code = await awaitExit(rec.proc, EXCHANGE_TIMEOUT_MS);
    if (code === 0) {
      rec.status = 'done';
      this.onAuthorized?.();
    } else {
      rec.status = 'failed';
      rec.error = failureReason(code, rec.output.slice(mark))
        ?? (code === null ? 'the login timed out completing the exchange' : `the login exited ${code}`);
    }
    this.retire(rec);
    return publicFlow(rec);
  }

  cancel(id: string): boolean {
    const rec = this.flows.get(id);
    if (!rec) return false;
    this.retire(rec);
    return true;
  }

  // A connector authorizes on claude.ai and the CLI exits immediately, so there is no exchange
  // to hang the reload on — the user tapping Done is the only moment the daemon learns the
  // grant has landed. Kept distinct from cancel(), which means the opposite.
  finishHandoff(id: string): boolean {
    const rec = this.flows.get(id);
    if (!rec || rec.kind !== 'handoff') return false;
    this.retire(rec);
    this.onAuthorized?.();
    return true;
  }

  private retire(rec: FlowRecord): void {
    if (rec.ttl) clearTimeout(rec.ttl);
    killGroup(rec.proc);
    this.flows.delete(rec.id);
  }
}
