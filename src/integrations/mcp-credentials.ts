import { readClaudeCredentials } from './claude-credentials.js';

// Reading MCP OAuth tokens is what lets the MCP panel say "expires in 2 days" instead of leaving
// a lapsed server to be discovered by a job failing mid-step, and what tells a server that
// renews itself (a refresh token is present) apart from one that needs a human every time.

export interface McpCredential {
  server: string;
  expiresAt?: number;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
}

// Best-effort by design: unreadable credentials leave the panel without expiry decoration,
// never an error — nothing here is required to render the servers themselves.
export async function readMcpCredentials(): Promise<McpCredential[]> {
  const creds = await readClaudeCredentials();
  return Object.entries(creds?.mcpOAuth ?? {}).map(([key, v]) => ({
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
