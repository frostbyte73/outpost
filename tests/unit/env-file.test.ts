import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile, resolveOpBin } from '../../src/env-file.js';

const ORIGINAL_ENV = { ...process.env };
const FAKE_VALUE = 'lin_api_fake_value';

const TOUCHED_KEYS = ['FAKE_A', 'FAKE_B', 'FAKE_C', 'FAKE_D'];

let dir: string;
let callsLog: string;

// Stand-in for the 1Password CLI. It records the reference it was asked for, so a test can
// assert both the value that reached process.env and how many subprocesses the load spent.
// `$2` is the argument after the `read` subcommand — i.e. the reference itself.
function writeFakeOp(script: string): string {
  const p = join(dir, 'op');
  writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "$2" >> ${JSON.stringify(callsLog)}\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}

function fakeOp(): string {
  return writeFakeOp(`printf '%s\\n' ${JSON.stringify(FAKE_VALUE)}`);
}

function envFile(content: string): string {
  const p = join(dir, '.env');
  writeFileSync(p, content);
  return p;
}

function opCalls(): string[] {
  if (!existsSync(callsLog)) return [];
  return readFileSync(callsLog, 'utf8').split('\n').filter(Boolean);
}

describe('loadEnvFile', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'envfile-'));
    callsLog = join(dir, 'calls.log');
    for (const k of TOUCHED_KEYS) delete process.env[k];
    delete process.env.OUTPOST_ENV_STRICT;
    delete process.env.OUTPOST_OP_BIN;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it('loads plain KEY=value lines without shelling out', () => {
    const path = envFile('FAKE_A=plain-value\n');

    expect(loadEnvFile(path, { opBin: fakeOp() })).toBe(1);
    expect(process.env.FAKE_A).toBe('plain-value');
    expect(opCalls()).toEqual([]);
  });

  it('resolves an op:// reference and sets the key to the secret', () => {
    const path = envFile('FAKE_A=op://Employee/linearkey/password\n');

    expect(loadEnvFile(path, { opBin: fakeOp() })).toBe(1);
    expect(process.env.FAKE_A).toBe(FAKE_VALUE);
    expect(opCalls()).toEqual(['op://Employee/linearkey/password']);
  });

  it('passes a reference containing spaces through to op intact', () => {
    const path = envFile('FAKE_A=op://Employee/Linear API Key/password\n');

    loadEnvFile(path, { opBin: fakeOp() });

    expect(process.env.FAKE_A).toBe(FAKE_VALUE);
    expect(opCalls()).toEqual(['op://Employee/Linear API Key/password']);
  });

  it('resolves a reference written with double quotes', () => {
    const path = envFile('FAKE_A="op://Employee/linearkey/password"\n');

    loadEnvFile(path, { opBin: fakeOp() });

    expect(process.env.FAKE_A).toBe(FAKE_VALUE);
  });

  it('resolves a reference written with single quotes', () => {
    const path = envFile("FAKE_A='op://Employee/linearkey/password'\n");

    loadEnvFile(path, { opBin: fakeOp() });

    expect(process.env.FAKE_A).toBe(FAKE_VALUE);
  });

  it('leaves a value alone when op:// is not at the start', () => {
    const path = envFile('FAKE_A=see op://Employee/linearkey/password\n');

    loadEnvFile(path, { opBin: fakeOp() });

    expect(process.env.FAKE_A).toBe('see op://Employee/linearkey/password');
    expect(opCalls()).toEqual([]);
  });

  it('spends one op call when two keys share a reference', () => {
    const path = envFile('FAKE_A=op://Employee/linearkey/password\nFAKE_B=op://Employee/linearkey/password\n');

    expect(loadEnvFile(path, { opBin: fakeOp() })).toBe(2);

    expect(process.env.FAKE_A).toBe(FAKE_VALUE);
    expect(process.env.FAKE_B).toBe(FAKE_VALUE);
    expect(opCalls()).toEqual(['op://Employee/linearkey/password']);
  });

  it('leaves an already-set key alone and never shells out for it', () => {
    process.env.FAKE_A = 'from-plist';
    const path = envFile('FAKE_A=op://Employee/linearkey/password\n');

    expect(loadEnvFile(path, { opBin: fakeOp() })).toBe(0);
    expect(process.env.FAKE_A).toBe('from-plist');
    expect(opCalls()).toEqual([]);
  });

  it('keeps the first of two duplicate keys, matching the plain-value parse', () => {
    const path = envFile('FAKE_A=first\nFAKE_A=second\n');

    expect(loadEnvFile(path, { opBin: fakeOp() })).toBe(1);
    expect(process.env.FAKE_A).toBe('first');
  });

  it('strips exactly one trailing newline and preserves other whitespace', () => {
    const opBin = writeFakeOp(`printf '%s\\n' "  padded value  "`);
    const path = envFile('FAKE_A=op://Employee/linearkey/password\n');

    loadEnvFile(path, { opBin });

    expect(process.env.FAKE_A).toBe('  padded value  ');
  });

  it('names the key and the reason when op refuses a reference', () => {
    const opBin = writeFakeOp(`printf '%s\\n' 'not signed in' >&2\nexit 1`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = envFile('FAKE_A=op://Employee/linearkey/password\nFAKE_B=plain\n');

    expect(loadEnvFile(path, { opBin })).toBe(1);

    expect(process.env.FAKE_A).toBeUndefined();
    expect(process.env.FAKE_B).toBe('plain');
    const message = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toContain('FAKE_A');
    expect(message).toContain('not signed in');
  });

  it('warns without shelling out at all when the 1Password CLI is missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = envFile('FAKE_A=op://Employee/linearkey/password\n');

    expect(loadEnvFile(path, { opBin: join(dir, 'no-such-op') })).toBe(0);

    expect(process.env.FAKE_A).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('FAKE_A');
    // Names the remedy: a bare ENOENT would leave the user with no next move.
    expect(String(warn.mock.calls[0]![0])).toContain('OUTPOST_OP_BIN');
  });

  it('gives up on a slow op rather than hanging the boot', () => {
    const opBin = writeFakeOp(`exec sleep 5`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = envFile('FAKE_A=op://Employee/linearkey/password\n');

    const started = Date.now();
    expect(loadEnvFile(path, { opBin, opTimeoutMs: 100 })).toBe(0);

    expect(Date.now() - started).toBeLessThan(3000);
    expect(process.env.FAKE_A).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    // Distinguishes "we gave up waiting" from "op refused" — the two need different fixes.
    expect(String(warn.mock.calls[0]![0])).toContain('timed out');
  });

  it('stays quiet on a load where every reference resolves', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = envFile('FAKE_A=op://Employee/linearkey/password\n');

    loadEnvFile(path, { opBin: fakeOp() });

    expect(warn).not.toHaveBeenCalled();
  });

  it('is fatal instead of a warning when OUTPOST_ENV_STRICT=1', () => {
    process.env.OUTPOST_ENV_STRICT = '1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = envFile('FAKE_A=op://Employee/linearkey/password\nFAKE_B=plain\n');

    expect(() => loadEnvFile(path, { opBin: writeFakeOp('exit 1') })).toThrow(/FAKE_A/);

    // The failed key is never assigned, so a fatal reference can't leave the raw `op://`
    // string sitting in the environment.
    expect(process.env.FAKE_A).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('finds op through an OUTPOST_OP_BIN written in the file itself', () => {
    const bin = fakeOp();
    const path = envFile(`OUTPOST_OP_BIN=${bin}\nFAKE_A=op://Employee/linearkey/password\n`);

    expect(loadEnvFile(path)).toBe(2);

    expect(process.env.FAKE_A).toBe(FAKE_VALUE);
    expect(opCalls()).toEqual(['op://Employee/linearkey/password']);
  });

  it('is fatal when OUTPOST_ENV_STRICT=1 is written in the file itself', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = envFile('OUTPOST_ENV_STRICT=1\nFAKE_A=op://Employee/linearkey/password\n');

    expect(() => loadEnvFile(path, { opBin: writeFakeOp('exit 1') })).toThrow(/FAKE_A/);

    expect(warn).not.toHaveBeenCalled();
  });

  it('never writes a resolved secret to a log', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = envFile('FAKE_A=op://Employee/linearkey/password\n');

    loadEnvFile(path, { opBin: fakeOp() });

    const printed = [...log.mock.calls, ...warn.mock.calls].flat().join('\n');
    expect(printed).toContain('FAKE_A');
    expect(printed).not.toContain(FAKE_VALUE);
  });

  it('finds op through OUTPOST_OP_BIN when no opBin is injected', () => {
    process.env.OUTPOST_OP_BIN = fakeOp();
    const path = envFile('FAKE_A=op://Employee/linearkey/password\n');

    expect(loadEnvFile(path)).toBe(1);

    expect(process.env.FAKE_A).toBe(FAKE_VALUE);
  });
});

describe('resolveOpBin', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'envfile-'));
    delete process.env.OUTPOST_OP_BIN;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('returns OUTPOST_OP_BIN when it points at a real file', () => {
    const bin = fakeOp();
    process.env.OUTPOST_OP_BIN = bin;

    expect(resolveOpBin()).toBe(bin);
  });

  it('ignores a stale OUTPOST_OP_BIN instead of failing on it', () => {
    process.env.OUTPOST_OP_BIN = join(dir, 'gone');

    const bin = resolveOpBin();

    expect(bin).not.toBe(join(dir, 'gone'));
    expect(bin).not.toBe('');
  });

  it('prefers a PATH entry over the built-in install directories', () => {
    const bin = fakeOp();
    process.env.PATH = dir;

    expect(resolveOpBin()).toBe(bin);
  });
});
