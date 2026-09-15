import { describe, it, expect } from 'vitest';
import { extractAuthUrl, parseRedirect } from '../../src/integrations/mcp-login.js';
import { LoginError, lastLine } from '../../src/integrations/cli-login.js';

// The two halves of cross-device MCP login worth pinning: pulling the authorization URL out of
// a pty stream that arrives in chunks, and vetting the redirect URL pasted back from a phone.
// The spawn itself isn't unit-testable (it needs a real `claude` and a real consent screen), so
// everything here is the pure logic around it.

// The CLI prints these ~3kB with a scope list, wrapped in an OSC-8 hyperlink whose target is a
// second copy of the same URL.
const AUTH = 'https://oauth.posthog.com/oauth/authorize/?response_type=code&code_challenge=NhHZ&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A53096%2Fcallback&state=DwcehrnZ&scope=insight%3Aread+alert%3Awrite&resource=https%3A%2F%2Fmcp-eu.posthog.com%2Fmcp';
const hyperlinked = (url: string): string => `\x1b[1G\x1b[0J  \x1b]8;;${url}\x1b\\${url}\x1b]8;;\x07\r\n`;
const withPrompt = (url: string): string =>
  `Starting authentication for "posthog"…\r\nVisit this URL to authorize:\r\n${hyperlinked(url)}Waiting for authorization… (^C to cancel)\r\n\x1b[1G\x1b[0JOr paste the redirect URL here: \x1b[33G`;

// A claude.ai connector's URL shares nothing with a configured server's: no PKCE challenge, no
// localhost redirect_uri, just a start-auth id. Matching on those query params rejected every
// connector — including Linear/Slack/DataDog, which this repo's permission groups depend on.
const CONNECTOR_AUTH = 'https://claude.ai/api/organizations/7762ca6a-12da-4a75-a3ea-efc4ebf84da1/mcp/start-auth/mcpsrv_01LQQSVPDLJhYtRmwAz2Xfa6?product_surface=sdk-cli';
const connectorOutput = (url: string): string =>
  `Visit this URL to authorize:\r\n${hyperlinked(url)}\r\nOnce authorized on claude.ai, the connector will be available the next time you start Claude Code.\r\n`;

describe('extractAuthUrl', () => {
  it('pulls the whole URL out of a hyperlinked pty stream', () => {
    expect(extractAuthUrl(withPrompt(AUTH))).toBe(AUTH);
  });

  it('reads a claude.ai connector URL, which carries no PKCE params at all', () => {
    expect(extractAuthUrl(connectorOutput(CONNECTOR_AUTH))).toBe(CONNECTOR_AUTH);
  });

  // The bug this exists for: resolving on the first chunk that merely CONTAINS the URL yields a
  // truncated one, which fails on the phone with nothing on screen to explain why. A partial
  // URL is indistinguishable from a whole one by content, so the only signal is the trailing
  // boundary — a match that runs to the end of the buffer has to be refused.
  it('refuses a URL still being streamed', () => {
    const cut = AUTH.slice(0, 200);
    expect(extractAuthUrl(`Visit this URL to authorize:\r\n  \x1b]8;;${cut}`)).toBeNull();
    expect(extractAuthUrl(`Visit this URL to authorize:\r\n  ${cut}`)).toBeNull();
  });

  it('accepts the URL once its terminator arrives', () => {
    expect(extractAuthUrl(`Visit this URL to authorize:\r\n  ${AUTH}\r\n`)).toBe(AUTH);
  });

  // Anchored on the CLI's label, so an unrelated URL in the output can't be mistaken for it.
  it('ignores output with no authorize marker', () => {
    expect(extractAuthUrl('See https://docs.example.com/mcp for help\r\n')).toBeNull();
    expect(extractAuthUrl('No MCP server named "Vercel". Configured servers: …\r\n')).toBeNull();
  });
});

describe('parseRedirect', () => {
  const ok = `http://localhost:53096/callback?code=abc123&state=DwcehrnZ`;

  it('accepts the redirect the flow issued', () => {
    expect(parseRedirect(AUTH, ok)).toContain('code=abc123');
  });

  it('tolerates the whitespace a phone paste carries', () => {
    expect(parseRedirect(AUTH, `  ${ok}\n`)).toContain('code=abc123');
  });

  it('rejects a paste that is not a URL', () => {
    expect(() => parseRedirect(AUTH, 'nonsense')).toThrow(/not a URL/);
  });

  // The likely misfire: copying the address bar BEFORE consenting, or the docs page instead.
  it('rejects a URL carrying no code', () => {
    expect(() => parseRedirect(AUTH, 'http://localhost:53096/callback?state=DwcehrnZ'))
      .toThrow(/no \?code=/);
  });

  it('surfaces a refusal the provider encoded in the redirect', () => {
    expect(() => parseRedirect(AUTH, 'http://localhost:53096/callback?error=access_denied'))
      .toThrow(/refused: access_denied/);
  });

  it('rejects a redirect belonging to another flow', () => {
    expect(() => parseRedirect(AUTH, 'http://localhost:53096/callback?code=abc&state=OTHER'))
      .toThrow(/different login flow/);
  });

  it('carries an HTTP status for the route to answer with', () => {
    try {
      parseRedirect(AUTH, 'nonsense');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LoginError);
      expect((e as LoginError).statusCode).toBe(400);
    }
  });
});

describe('lastLine', () => {
  // A failed exchange's only explanation is the CLI's own final line; the daemon quotes it
  // rather than inventing one.
  it('returns the CLI last word, escapes stripped', () => {
    expect(lastLine('\x1b[1G\x1b[0Jexchanging…\r\nCouldn\'t complete authentication: invalid_grant\r\n'))
      .toBe("Couldn't complete authentication: invalid_grant");
  });

  it('is null when there is nothing to quote', () => {
    expect(lastLine('\r\n  \x1b[0J\r\n')).toBeNull();
  });
});
