import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOGIN_SPECS, RuntimeLoginFlows, parseStatus } from '../../src/integrations/runtime-login.js';

// Captured from the real CLIs: neither needs a pty, both print a link and then finish by
// themselves once it is approved.
const CODEX_OUT = '\nWelcome to Codex [v\x1b[90m0.172.0\x1b[0m]\n\nFollow these steps:\n\n1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94m1BJN-48VND\x1b[0m\n\nContinue only if you started this login in Codex.\n';
const CURSOR_OUT = 'Starting login process...\nWaiting for browser authentication...\nOpen a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=abc&uuid=1&mode=login\n';

describe('login prompt parsing', () => {
  it('reads the link and the one-time code from the Codex device flow', () => {
    expect(LOGIN_SPECS.codex.parsePrompt(CODEX_OUT)).toEqual({
      authUrl: 'https://auth.openai.com/codex/device', code: '1BJN-48VND',
    });
  });

  // The link prints before the code, and a link alone is useless to the user.
  it('waits for the code rather than resolving on the link', () => {
    expect(LOGIN_SPECS.codex.parsePrompt(CODEX_OUT.split('2. Enter')[0]!)).toBeNull();
  });

  it('reads the Cursor link, and refuses one still streaming', () => {
    expect(LOGIN_SPECS.cursor.parsePrompt(CURSOR_OUT)).toEqual({
      authUrl: 'https://cursor.com/loginDeepControl?challenge=abc&uuid=1&mode=login',
    });
    expect(LOGIN_SPECS.cursor.parsePrompt(CURSOR_OUT.trimEnd().slice(0, -10))).toBeNull();
  });
});

describe('parseStatus', () => {
  it('reads a signed-in Codex and Cursor', () => {
    expect(parseStatus('Logged in using ChatGPT\n')).toEqual({ loggedIn: true, detail: 'Logged in using ChatGPT' });
    expect(parseStatus('✓ Logged in as dc@livekit.io\nTeam: LiveKit (id 1)\n'))
      .toEqual({ loggedIn: true, detail: 'Logged in as dc@livekit.io · Team: LiveKit (id 1)' });
  });

  it('reads signed out as an answer, and unreadable output as a failed probe', () => {
    expect(parseStatus('Not logged in\n')).toEqual({ loggedIn: false });
    expect(parseStatus('boom').error).toBe('boom');
  });
});

function fakeBin(script: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'rt-login-')), 'cli');
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
};

describe('RuntimeLoginFlows', () => {
  it('relays the link, then settles done when the CLI exits 0', async () => {
    const bin = fakeBin(`printf '%s' '${CURSOR_OUT}'; sleep 0.3`);
    const signedIn: string[] = [];
    const flows = new RuntimeLoginFlows(() => bin, (r) => signedIn.push(r));
    const flow = await flows.start('cursor');
    expect(flow.status).toBe('awaiting');
    expect(flow.authUrl).toContain('cursor.com');
    // A second caller gets the flow already in flight.
    expect((await flows.start('cursor')).id).toBe(flow.id);
    await until(() => flows.current('cursor')?.status !== 'awaiting');
    expect(flows.current('cursor')?.status).toBe('done');
    expect(signedIn).toEqual(['cursor']);
  });

  it('settles failed with the CLI\'s last line when it exits non-zero', async () => {
    const bin = fakeBin(`printf '%s' '${CURSOR_OUT}'; sleep 0.2; echo "authentication denied"; exit 1`);
    const flows = new RuntimeLoginFlows(() => bin);
    await flows.start('cursor');
    await until(() => flows.current('cursor')?.status !== 'awaiting');
    expect(flows.current('cursor')).toMatchObject({ status: 'failed', error: 'authentication denied' });
  });

  it('refuses a runtime that is not installed, and drops a cancelled flow', async () => {
    await expect(new RuntimeLoginFlows(() => null).start('codex')).rejects.toMatchObject({ statusCode: 404 });
    const flows = new RuntimeLoginFlows(() => fakeBin(`printf '%s' '${CURSOR_OUT}'; sleep 5`));
    await flows.start('cursor');
    expect(flows.cancel('cursor')).toBe(true);
    expect(flows.current('cursor')).toBeNull();
  });
});
