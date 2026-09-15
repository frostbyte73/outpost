import { describe, it, expect } from 'vitest';
import { dueForReauth, notificationFor } from '../../src/integrations/mcp-expiry-watcher.js';
import { authKindOf } from '../../src/integrations/mcp-config.js';
import type { McpCredential } from '../../src/integrations/mcp-credentials.js';

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);
const inHours = (h: number): number => NOW + h * 3600000;

const creds = (...list: McpCredential[]): Map<string, McpCredential> =>
  new Map(list.map((c) => [c.server, c]));

describe('dueForReauth', () => {
  it('says nothing about a credential that renews itself', () => {
    expect(dueForReauth(['notion'], creds({
      server: 'notion', hasAccessToken: true, hasRefreshToken: true, expiresAt: inHours(2),
    }), NOW)).toEqual([]);
  });

  // The case that motivated surfacing expiry: a long-lived token with no refresh token means
  // every lapse is a manual, two-device login.
  it('warns about a no-refresh-token credential inside the window', () => {
    expect(dueForReauth(['incident-io'], creds({
      server: 'incident-io', hasAccessToken: true, hasRefreshToken: false, expiresAt: inHours(30),
    }), NOW)).toEqual([{ server: 'incident-io', expired: false, hoursLeft: 30 }]);
  });

  it('stays quiet while that credential is still comfortably valid', () => {
    expect(dueForReauth(['incident-io'], creds({
      server: 'incident-io', hasAccessToken: true, hasRefreshToken: false, expiresAt: inHours(222),
    }), NOW)).toEqual([]);
  });

  it('reports an expired credential even when a refresh token is present', () => {
    expect(dueForReauth(['linear'], creds({
      server: 'linear', hasAccessToken: true, hasRefreshToken: true, expiresAt: inHours(-2100),
    }), NOW)).toEqual([{ server: 'linear', expired: true, hoursLeft: 0 }]);
  });

  it('ignores a server with no credential record at all', () => {
    expect(dueForReauth(['livekit-docs'], creds(), NOW)).toEqual([]);
  });

  // The false alarm this guards against: a server authenticating by PAT header can still carry
  // an empty `mcpOAuth` record from an abandoned OAuth attempt. authKindOf keeps it off the
  // list, so an empty access token is never read as a lapse on a server that works fine.
  it('never sees a header-authenticated server, empty OAuth record and all', () => {
    const cfg = { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ghp_x' } };
    expect(authKindOf(cfg)).toBe('header');
    const record: McpCredential = { server: 'github', hasAccessToken: false, hasRefreshToken: false };
    // Present in the keychain, absent from the OAuth server list the watcher passes in.
    expect(dueForReauth([], creds(record), NOW)).toEqual([]);
    expect(dueForReauth(['github'], creds(record), NOW))
      .toEqual([{ server: 'github', expired: true, hoursLeft: 0 }]);
  });
});

describe('notificationFor', () => {
  it('is null when nothing is due', () => {
    expect(notificationFor([])).toBeNull();
  });

  it('names the single server and why it needs a human', () => {
    expect(notificationFor([{ server: 'incident-io', expired: false, hoursLeft: 30 }]))
      .toMatchObject({ title: 'incident-io expires in 30h' });
    expect(notificationFor([{ server: 'linear', expired: true, hoursLeft: 0 }]))
      .toMatchObject({ title: 'linear needs re-authorizing' });
  });

  it('summarizes a mixed batch without dropping either half', () => {
    const n = notificationFor([
      { server: 'linear', expired: true, hoursLeft: 0 },
      { server: 'incident-io', expired: false, hoursLeft: 12 },
    ]);
    expect(n?.title).toBe('2 MCP servers need re-authorizing');
    expect(n?.body).toContain('linear expired');
    expect(n?.body).toContain('incident-io in 12h');
  });
});
