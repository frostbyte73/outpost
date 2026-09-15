import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Claude Code keeps MCP OAuth tokens in the login keychain rather than a file the daemon can
// watch. Reading them is what lets the MCP panel say "expires in 2 days" instead of leaving a
// lapsed server to be discovered by a job failing mid-step, and what tells a server that
// renews itself (a refresh token is present) apart from one that needs a human every time.

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
// A keychain ACL prompt would otherwise hold this open indefinitely.
const READ_TIMEOUT_MS = 3000;

const execFileAsync = promisify(execFile);

export interface McpCredential {
  server: string;
  expiresAt?: number;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
}

interface StoredOAuth {
  serverName?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

// Best-effort by design: an unreadable keychain leaves the panel without expiry decoration,
// never an error — nothing here is required to render the servers themselves.
export async function readMcpCredentials(): Promise<McpCredential[]> {
  let raw: string;
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8', timeout: READ_TIMEOUT_MS },
    );
    raw = stdout;
  } catch {
    return [];
  }
  let parsed: { mcpOAuth?: Record<string, StoredOAuth> };
  try {
    parsed = JSON.parse(raw) as { mcpOAuth?: Record<string, StoredOAuth> };
  } catch {
    return [];
  }
  return Object.entries(parsed.mcpOAuth ?? {}).map(([key, v]) => ({
    // Keys are `<serverName>|<hash>`; the record's own field wins where it's present.
    server: v.serverName ?? key.split('|')[0]!,
    ...(typeof v.expiresAt === 'number' ? { expiresAt: v.expiresAt } : {}),
    hasAccessToken: !!v.accessToken,
    hasRefreshToken: !!v.refreshToken,
  }));
}

export async function credentialsByServer(): Promise<Map<string, McpCredential>> {
  const byServer = new Map<string, McpCredential>();
  for (const c of await readMcpCredentials()) byServer.set(c.server, c);
  return byServer;
}
