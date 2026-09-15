import { describe, it, expect } from 'vitest';
import { isAuthFailure, parseCode } from '../../src/integrations/claude-login.js';
import { LoginError, urlAfter } from '../../src/integrations/cli-login.js';

// Re-authorizing Claude Code's own account from another device. The spawn isn't unit-testable
// (it needs a real CLI and a real consent screen), so this pins the pure logic around it: the
// URL scraped out of the pty, what comes back from the authorizing device, and recognising the
// failure that makes the whole flow necessary.

const AUTH = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=leDgXab&code_challenge_method=S256&state=eiolgzOG';
const MARKER = /open, visit:/;

// Captured from a real `claude auth login` under expect: the URL arrives twice, once as the
// OSC-8 target and once as its visible text, and the paste prompt follows it.
const ptyOutput = (url: string): string =>
  `Opening browser to sign in…\r\nIf the browser didn't open, visit: \x1b]8;;${url}\x1b\\${url}\x1b]8;;\x07\r\nPaste code here if prompted > `;

describe('authorization URL extraction', () => {
  it('pulls the whole URL out of a hyperlinked pty stream', () => {
    expect(urlAfter(ptyOutput(AUTH), MARKER)).toBe(AUTH);
  });

  // The marker deliberately skips the apostrophe in "didn't" — matching U+0027 would break the
  // moment the CLI rendered a typographic one.
  it('matches regardless of which apostrophe the CLI printed', () => {
    expect(urlAfter(ptyOutput(AUTH).replace("didn't", 'didn’t'), MARKER)).toBe(AUTH);
  });

  // Resolving on a chunk that merely CONTAINS a URL yields a truncated one, which fails on the
  // phone with nothing on screen to explain why.
  it('refuses a URL still being streamed', () => {
    expect(urlAfter(`If the browser didn't open, visit: ${AUTH.slice(0, 80)}`, MARKER)).toBeNull();
  });
});

describe('parseCode', () => {
  it('passes a code#state paste through untouched — it is already what the CLI wants', () => {
    expect(parseCode(AUTH, 'ac_123#eiolgzOG')).toBe('ac_123#eiolgzOG');
  });

  it('tolerates the whitespace a phone paste carries', () => {
    expect(parseCode(AUTH, '  ac_123#eiolgzOG\n')).toBe('ac_123#eiolgzOG');
  });

  // A bare code is handed over as-is rather than having a state invented for it.
  it('accepts a bare code', () => {
    expect(parseCode(AUTH, 'ac_123')).toBe('ac_123');
  });

  // Pasting the address bar instead of the code is the likely misfire, and the one case where
  // the two halves arrive separated.
  it('recombines a pasted callback URL into code#state', () => {
    expect(parseCode(AUTH, 'https://platform.claude.com/oauth/code/callback?code=ac_123&state=eiolgzOG'))
      .toBe('ac_123#eiolgzOG');
  });

  it('rejects a URL carrying no code', () => {
    expect(() => parseCode(AUTH, 'https://platform.claude.com/oauth/code/callback?state=eiolgzOG'))
      .toThrow(/no \?code=/);
  });

  it('surfaces a refusal the provider encoded in the redirect', () => {
    expect(() => parseCode(AUTH, 'https://platform.claude.com/oauth/code/callback?error=access_denied'))
      .toThrow(/refused: access_denied/);
  });

  it('rejects a code belonging to another flow, in either paste shape', () => {
    expect(() => parseCode(AUTH, 'ac_123#OTHER')).toThrow(/different login flow/);
    expect(() => parseCode(AUTH, 'https://platform.claude.com/oauth/code/callback?code=ac_123&state=OTHER'))
      .toThrow(/different login flow/);
  });

  it('rejects prose', () => {
    expect(() => parseCode(AUTH, 'here is the code ac_123')).toThrow(/does not look like/);
    expect(() => parseCode(AUTH, '   ')).toThrow(/paste the code/);
  });

  it('carries an HTTP status for the route to answer with', () => {
    try {
      parseCode(AUTH, '');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LoginError);
      expect((e as LoginError).statusCode).toBe(400);
    }
  });
});

describe('isAuthFailure', () => {
  // The line that started all this. It is the ONLY announcement the daemon gets — it arrives on
  // a dying session's stderr, and the exit code is the same 1 every other failure uses.
  it('recognises the expired-session complaint', () => {
    expect(isAuthFailure('[claude stderr] Failed to authenticate: OAuth session expired and could not be refreshed')).toBe(true);
  });

  it('recognises the other spellings of the same remedy', () => {
    expect(isAuthFailure('Invalid API key · Please run /login')).toBe(true);
  });

  it('ignores unrelated stderr', () => {
    expect(isAuthFailure('[claude stderr] warning: MCP server "linear" failed to start')).toBe(false);
    expect(isAuthFailure('[claude stderr] TypeError: undefined is not a function')).toBe(false);
  });
});
