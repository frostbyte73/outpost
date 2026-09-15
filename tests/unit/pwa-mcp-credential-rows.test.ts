import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { mcpServerRows, mcpNeedsAttention } from '../../src/pwa/vm/settings.js';

// What the MCP panel is allowed to claim about a credential. The distinction that carries the
// feature: a server holding a REFRESH token renews itself, so its access-token expiry is noise;
// one without needs a human every time it lapses, which is the only case worth a badge.

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);
const inHours = (h: number): number => NOW + h * 3600000;

const server = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ name: 'notion', transport: 'http', status: 'ok', auth: 'oauth', ...over });

const row = (over: Record<string, unknown> = {}) => mcpServerRows([server(over)], NOW)[0];

describe('mcpServerRows credentials', () => {
  it('stays quiet about a self-renewing server even close to expiry', () => {
    const r = row({ credential: { hasAccessToken: true, hasRefreshToken: true, expiresAt: inHours(1) } });
    expect(r.credentialLabel).toBeNull();
    expect(r.needsAttention).toBe(false);
  });

  it('counts down a server that cannot renew itself', () => {
    const r = row({ credential: { hasAccessToken: true, hasRefreshToken: false, expiresAt: inHours(222) } });
    expect(r.credentialLabel).toBe('Expires in 9d');
    expect(r.needsAttention).toBe(false);
  });

  it('warns inside the two-day window', () => {
    const r = row({ credential: { hasAccessToken: true, hasRefreshToken: false, expiresAt: inHours(20) } });
    expect(r.credentialLabel).toBe('Expires in 20h');
    expect(r.credentialTone).toBe('warn');
    expect(r.needsAttention).toBe(true);
  });

  // A refresh token that lapsed is dead too — the expiry is what matters, not its presence.
  it('flags an expired credential regardless of refresh token', () => {
    const r = row({ credential: { hasAccessToken: true, hasRefreshToken: true, expiresAt: inHours(-1) } });
    expect(r.credentialLabel).toBe('Expired');
    expect(r.needsAttention).toBe(true);
  });

  it('flags a server that was never authorized', () => {
    const r = row({ credential: { hasAccessToken: false, hasRefreshToken: false } });
    expect(r.credentialLabel).toBe('Not authorized');
    expect(r.needsAttention).toBe(true);
  });
});

describe('re-authorize affordance', () => {
  // Offering a login for either of these would be a button that cannot help: stdio carries
  // credentials in its env, and a header-authenticated server carries a token.
  it('is offered only for OAuth servers', () => {
    expect(row().canReauth).toBe(true);
    expect(row({ auth: 'stdio', transport: 'stdio' }).canReauth).toBe(false);
    expect(row({ auth: 'header' }).canReauth).toBe(false);
  });

  it('names how a non-OAuth server authenticates instead', () => {
    expect(row({ auth: 'header' }).authNote).toBe('token header');
    expect(row({ auth: 'stdio', transport: 'stdio' }).authNote).toBe('env credentials');
    expect(row().authNote).toBeNull();
  });

  it('says nothing about a server with no credential record', () => {
    expect(row().credentialLabel).toBeNull();
    expect(row().needsAttention).toBe(false);
  });
});

describe('mcpNeedsAttention', () => {
  it('is true when any server needs a human', () => {
    expect(mcpNeedsAttention([
      server({ credential: { hasAccessToken: true, hasRefreshToken: true, expiresAt: inHours(99) } }),
      server({ name: 'incident-io', credential: { hasAccessToken: true, hasRefreshToken: false, expiresAt: inHours(3) } }),
    ], NOW)).toBe(true);
  });

  it('is false for a healthy fleet', () => {
    expect(mcpNeedsAttention([server({ auth: 'stdio', transport: 'stdio' }), server()], NOW)).toBe(false);
  });
});
