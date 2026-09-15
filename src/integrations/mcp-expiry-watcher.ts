import { authKindOf, mergeMcpServers } from './mcp-config.js';
import { credentialsByServer, type McpCredential } from './mcp-credentials.js';

// Notifies when an MCP OAuth credential needs a human. Timing is the whole point: a token that
// lapses unnoticed gets discovered by a job failing mid-step, and re-authorizing is a
// two-device errand the user wants to pick a moment for rather than be ambushed by.

const WARN_AHEAD_MS = 2 * 24 * 60 * 60 * 1000;

export interface ReauthDue {
  server: string;
  expired: boolean;
  hoursLeft: number;
}

// A credential holding a refresh token renews itself, so only an already-lapsed one counts
// there. Without one, every expiry is a manual login and the warning window applies. Mirrors
// vm/settings.js's credentialNote, which decides the same thing for the panel's badge.
export function dueForReauth(
  oauthServers: string[], creds: Map<string, McpCredential>, now: number,
): ReauthDue[] {
  const due: ReauthDue[] = [];
  for (const server of oauthServers) {
    const cred = creds.get(server);
    if (!cred) continue;
    if (!cred.hasAccessToken) {
      due.push({ server, expired: true, hoursLeft: 0 });
      continue;
    }
    if (cred.expiresAt === undefined) continue;
    const ms = cred.expiresAt - now;
    if (ms <= 0) due.push({ server, expired: true, hoursLeft: 0 });
    else if (!cred.hasRefreshToken && ms < WARN_AHEAD_MS) {
      due.push({ server, expired: false, hoursLeft: Math.round(ms / 3600000) });
    }
  }
  return due;
}

export function notificationFor(due: ReauthDue[]): { title: string; body: string } | null {
  if (due.length === 0) return null;
  const expired = due.filter((d) => d.expired).map((d) => d.server);
  const soon = due.filter((d) => !d.expired);
  if (due.length === 1) {
    const one = due[0]!;
    return one.expired
      ? { title: `${one.server} needs re-authorizing`, body: 'Its MCP credential has expired. Tap to authorize from any device.' }
      : { title: `${one.server} expires in ${one.hoursLeft}h`, body: 'It has no refresh token, so this one needs a manual login. Tap to authorize.' };
  }
  const parts = [
    expired.length ? `${expired.join(', ')} expired` : null,
    soon.length ? `${soon.map((d) => `${d.server} in ${d.hoursLeft}h`).join(', ')}` : null,
  ].filter(Boolean);
  return { title: `${due.length} MCP servers need re-authorizing`, body: `${parts.join('; ')}. Tap to authorize.` };
}

export interface McpExpiryWatcherOpts {
  mcpConfigPath: string;
  notify: (payload: { title: string; body: string; tag: string; data: Record<string, unknown> }) => void;
  now?: () => number;
}

export class McpExpiryWatcher {
  private readonly now: () => number;

  constructor(private readonly opts: McpExpiryWatcherOpts) {
    this.now = opts.now ?? (() => Date.now());
  }

  async runOnce(): Promise<{ outcome: 'ok' | 'error' }> {
    const servers = mergeMcpServers(this.opts.mcpConfigPath);
    const oauth = [...servers.entries()].filter(([, cfg]) => authKindOf(cfg) === 'oauth').map(([name]) => name);
    const due = dueForReauth(oauth, await credentialsByServer(), this.now());
    const payload = notificationFor(due);
    if (!payload) return { outcome: 'ok' };
    // One tag for the whole sweep, so a daily re-fire replaces the previous card instead of
    // stacking a new one for a lapse the user has already seen.
    this.opts.notify({ ...payload, tag: 'mcp-expiry', data: { kind: 'mcp-expiry' } });
    return { outcome: 'ok' };
  }
}
