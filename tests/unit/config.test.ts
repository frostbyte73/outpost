import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';

const ORIGINAL_ENV = { ...process.env };

describe('loadConfig', () => {
  beforeEach(() => {
    delete process.env.OUTPOST_RUNTIME_DIR;
    delete process.env.OUTPOST_HTTPS_PORT;
    delete process.env.OUTPOST_HOOK_PORT;
    delete process.env.OUTPOST_HOST;
    delete process.env.OUTPOST_BIND_ADDRESS;
    delete process.env.OUTPOST_CERT_PATH;
    delete process.env.OUTPOST_KEY_PATH;
    delete process.env.OUTPOST_PROJECTS_ROOT;
    delete process.env.OUTPOST_APPROVAL_TIMEOUT_MS;
    delete process.env.OUTPOST_ALLOWLIST_PATH;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('runtimeDir defaults to ~/.outpost when OUTPOST_RUNTIME_DIR is unset', () => {
    const c = loadConfig();
    expect(c.runtimeDir).toBe(join(homedir(), '.outpost'));
  });

  it('runtimeDir honors OUTPOST_RUNTIME_DIR when set', () => {
    process.env.OUTPOST_RUNTIME_DIR = '/tmp/outpost-test';
    const c = loadConfig();
    expect(c.runtimeDir).toBe('/tmp/outpost-test');
  });

  it('httpsPort defaults to 8443; honors OUTPOST_HTTPS_PORT', () => {
    expect(loadConfig().httpsPort).toBe(8443);
    process.env.OUTPOST_HTTPS_PORT = '9999';
    expect(loadConfig().httpsPort).toBe(9999);
  });

  it('hookPort defaults to 8444; honors OUTPOST_HOOK_PORT', () => {
    expect(loadConfig().hookPort).toBe(8444);
    process.env.OUTPOST_HOOK_PORT = '9998';
    expect(loadConfig().hookPort).toBe(9998);
  });

  it('host defaults to undefined (let tailscale discovery decide); honors OUTPOST_HOST', () => {
    expect(loadConfig().host).toBeUndefined();
    process.env.OUTPOST_HOST = 'localhost.test';
    expect(loadConfig().host).toBe('localhost.test');
  });

  it('bindAddress defaults to undefined (tailscale discovery); honors OUTPOST_BIND_ADDRESS', () => {
    expect(loadConfig().bindAddress).toBeUndefined();
    process.env.OUTPOST_BIND_ADDRESS = '127.0.0.1';
    expect(loadConfig().bindAddress).toBe('127.0.0.1');
  });

  it('projectsRoot defaults to ~/.claude/projects; honors OUTPOST_PROJECTS_ROOT', () => {
    expect(loadConfig().projectsRoot).toBe(join(homedir(), '.claude', 'projects'));
    process.env.OUTPOST_PROJECTS_ROOT = '/tmp/projects';
    expect(loadConfig().projectsRoot).toBe('/tmp/projects');
  });

  it('rejects non-numeric ports', () => {
    process.env.OUTPOST_HTTPS_PORT = 'not-a-port';
    expect(() => loadConfig()).toThrow(/OUTPOST_HTTPS_PORT/);
  });

  it('certPath and keyPath default to undefined; honor env vars', () => {
    expect(loadConfig().certPath).toBeUndefined();
    expect(loadConfig().keyPath).toBeUndefined();
    process.env.OUTPOST_CERT_PATH = '/tmp/cert.pem';
    process.env.OUTPOST_KEY_PATH = '/tmp/key.pem';
    const c = loadConfig();
    expect(c.certPath).toBe('/tmp/cert.pem');
    expect(c.keyPath).toBe('/tmp/key.pem');
  });

  it('approvalTimeoutMs defaults to 600_000 (10 min); honors OUTPOST_APPROVAL_TIMEOUT_MS', () => {
    expect(loadConfig().approvalTimeoutMs).toBe(10 * 60 * 1000);
    process.env.OUTPOST_APPROVAL_TIMEOUT_MS = '2000';
    expect(loadConfig().approvalTimeoutMs).toBe(2000);
  });

  it('rejects negative approvalTimeoutMs', () => {
    process.env.OUTPOST_APPROVAL_TIMEOUT_MS = '-5';
    expect(() => loadConfig()).toThrow(/OUTPOST_APPROVAL_TIMEOUT_MS/);
  });

  it('allowlistPath defaults to undefined (use repo config); honors OUTPOST_ALLOWLIST_PATH', () => {
    expect(loadConfig().allowlistPath).toBeUndefined();
    process.env.OUTPOST_ALLOWLIST_PATH = '/tmp/al.json';
    expect(loadConfig().allowlistPath).toBe('/tmp/al.json');
  });
});

describe('loadConfig push knobs', () => {
  beforeEach(() => {
    delete process.env.OUTPOST_VAPID_PATH;
    delete process.env.OUTPOST_PUSH_SUBS_PATH;
    delete process.env.OUTPOST_STOP_THRESHOLD_MS;
    delete process.env.OUTPOST_PUSH_TTL_SECONDS;
    delete process.env.OUTPOST_RUNTIME_DIR;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('defaults vapidPath and pushSubscriptionsPath under runtimeDir', () => {
    process.env.OUTPOST_RUNTIME_DIR = '/tmp/outpost-cfg-test';
    const c = loadConfig();
    expect(c.vapidPath).toBe('/tmp/outpost-cfg-test/vapid.json');
    expect(c.pushSubscriptionsPath).toBe('/tmp/outpost-cfg-test/push-subscriptions.json');
  });

  it('honors OUTPOST_VAPID_PATH and OUTPOST_PUSH_SUBS_PATH overrides', () => {
    process.env.OUTPOST_VAPID_PATH = '/var/lib/outpost/vapid.json';
    process.env.OUTPOST_PUSH_SUBS_PATH = '/var/lib/outpost/subs.json';
    const c = loadConfig();
    expect(c.vapidPath).toBe('/var/lib/outpost/vapid.json');
    expect(c.pushSubscriptionsPath).toBe('/var/lib/outpost/subs.json');
  });

  it('defaults stopHookThresholdMs to 30_000 and pushTtlSeconds to 60', () => {
    const c = loadConfig();
    expect(c.stopHookThresholdMs).toBe(30_000);
    expect(c.pushTtlSeconds).toBe(60);
  });

  it('honors threshold + TTL overrides', () => {
    process.env.OUTPOST_STOP_THRESHOLD_MS = '5000';
    process.env.OUTPOST_PUSH_TTL_SECONDS = '120';
    const c = loadConfig();
    expect(c.stopHookThresholdMs).toBe(5_000);
    expect(c.pushTtlSeconds).toBe(120);
  });

  it('rejects negative stopHookThresholdMs', () => {
    process.env.OUTPOST_STOP_THRESHOLD_MS = '-1';
    expect(() => loadConfig()).toThrow(/OUTPOST_STOP_THRESHOLD_MS/);
  });
});
