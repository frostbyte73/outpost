import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DaemonConfig {
  runtimeDir: string;
  projectsRoot: string;
  httpsPort: number;
  httpPort: number | null;
  hookPort: number;
  host: string | undefined;
  bindAddress: string | undefined;
  certPath: string | undefined;
  keyPath: string | undefined;
  approvalTimeoutMs: number;
  allowlistPath: string | undefined;
  vapidPath: string;
  pushSubscriptionsPath: string;
  stopHookThresholdMs: number;
  pushTtlSeconds: number;
}

function readPort(envName: string, defaultValue: number): number {
  const raw = process.env[envName];
  if (raw === undefined) return defaultValue;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${envName} must be an integer in [1, 65535], got ${JSON.stringify(raw)}`);
  }
  return n;
}

function readPortOrDisabled(envName: string): number | null {
  const raw = process.env[envName];
  if (raw === undefined || raw === '') return 8080;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`${envName} must be an integer in [0, 65535] (0 disables), got ${JSON.stringify(raw)}`);
  }
  return n === 0 ? null : n;
}

function readMs(envName: string, defaultValue: number): number {
  const raw = process.env[envName];
  if (raw === undefined) return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${envName} must be a non-negative number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function readPositiveInt(envName: string, defaultValue: number): number {
  const raw = process.env[envName];
  if (raw === undefined) return defaultValue;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${envName} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function loadConfig(): DaemonConfig {
  const runtimeDir = process.env.OUTPOST_RUNTIME_DIR ?? join(homedir(), '.outpost');
  return {
    runtimeDir,
    projectsRoot: process.env.OUTPOST_PROJECTS_ROOT ?? join(homedir(), '.claude', 'projects'),
    httpsPort: readPort('OUTPOST_HTTPS_PORT', 8443),
    httpPort: readPortOrDisabled('OUTPOST_HTTP_PORT'),
    hookPort: readPort('OUTPOST_HOOK_PORT', 8444),
    host: process.env.OUTPOST_HOST,
    bindAddress: process.env.OUTPOST_BIND_ADDRESS,
    certPath: process.env.OUTPOST_CERT_PATH,
    keyPath: process.env.OUTPOST_KEY_PATH,
    approvalTimeoutMs: readMs('OUTPOST_APPROVAL_TIMEOUT_MS', 10 * 60 * 1000),
    allowlistPath: process.env.OUTPOST_ALLOWLIST_PATH,
    vapidPath: process.env.OUTPOST_VAPID_PATH ?? join(runtimeDir, 'vapid.json'),
    pushSubscriptionsPath: process.env.OUTPOST_PUSH_SUBS_PATH ?? join(runtimeDir, 'push-subscriptions.json'),
    stopHookThresholdMs: readMs('OUTPOST_STOP_THRESHOLD_MS', 30 * 1000),
    pushTtlSeconds: readPositiveInt('OUTPOST_PUSH_TTL_SECONDS', 60),
  };
}
