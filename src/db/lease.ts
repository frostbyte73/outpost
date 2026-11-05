import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Backend, Lease } from './backend.js';
import { openStore, parseStoreUrl } from './open.js';

export interface BootedStore {
  backend: Backend;
  lease: Lease;
  currentEpoch(): number;
}

// Opens OUTPOST_STORE, takes the control-plane lease, then migrates: the daemon's boot order.
export async function bootStore(runtimeDir: string, env: NodeJS.ProcessEnv): Promise<BootedStore> {
  const holderId = resolveHolderId(runtimeDir);
  const backend = await openStore(parseStoreUrl(env.OUTPOST_STORE, runtimeDir), { allowTestOnly: false });
  try {
    const lease = await backend.acquireLease({ holderId, holderAddr: hostname() }, { force: env.OUTPOST_LEASE_FORCE === '1' });
    await backend.migrate();
    return { backend, lease, currentEpoch: () => lease.epoch };
  } catch (err) {
    await backend.close();
    throw err;
  }
}

// A file, not the hostname: macOS hostnames drift with the network, and a drift would read as another holder.
function resolveHolderId(runtimeDir: string): string {
  const path = join(runtimeDir, 'cp-holder-id');
  const existing = existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
  if (existing) return existing;
  const id = randomUUID();
  // Durable before it's visible: a power-loss-emptied id is a new holder, and boot fails on LeaseHeld forever.
  const tmp = openSync(`${path}.tmp`, 'w', 0o600);
  writeSync(tmp, `${id}\n`);
  fsyncSync(tmp);
  closeSync(tmp);
  renameSync(`${path}.tmp`, path);
  const dir = openSync(runtimeDir, 'r');
  fsyncSync(dir);
  closeSync(dir);
  return id;
}
