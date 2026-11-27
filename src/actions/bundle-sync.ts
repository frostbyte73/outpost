import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

// What the last sync installed per bundled action, to tell an untouched copy from a user edit.
export interface BundleState {
  version: 1;
  baselines: Record<string, string>;
  editedLocally: string[];
}

export const BUNDLE_STATE_FILE = 'action-bundles.json';
// Outside actions/, so the registry and skill delivery never see a half-swapped dir.
export const STAGING_DIR = '.action-staging';

function emptyState(): BundleState {
  return { version: 1, baselines: {}, editedLocally: [] };
}

export function readBundleState(runtimeDir: string): BundleState {
  try {
    const raw = JSON.parse(readFileSync(join(runtimeDir, BUNDLE_STATE_FILE), 'utf8')) as Partial<BundleState>;
    if (raw?.version !== 1 || typeof raw.baselines !== 'object' || raw.baselines === null) return emptyState();
    return {
      version: 1,
      baselines: raw.baselines,
      editedLocally: Array.isArray(raw.editedLocally) ? raw.editedLocally : [],
    };
  } catch {
    return emptyState();
  }
}

export function writeBundleState(runtimeDir: string, state: BundleState): void {
  const path = join(runtimeDir, BUNDLE_STATE_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

// Action names (`<category>.<name>`) whose local edits kept a newer bundled version out.
export function readLocalEdits(runtimeDir: string): string[] {
  return readBundleState(runtimeDir).editedLocally;
}

// Finder litter must not read as a user edit; any other dotfile is real content.
function visibleEntries(dir: string): string[] {
  return readdirSync(dir).filter((n) => n !== '.DS_Store').sort();
}

export function bundleHash(dir: string): string {
  const h = createHash('sha256');
  const walk = (abs: string, rel: string): void => {
    for (const name of visibleEntries(abs)) {
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (statSync(childAbs).isDirectory()) { walk(childAbs, childRel); continue; }
      h.update(`${childRel}\0`);
      h.update(readFileSync(childAbs));
      h.update('\0');
    }
  };
  walk(dir, '');
  return h.digest('hex');
}

// Swaps dst for a copy of src via renames, so a crash leaves dst old, missing, or new — never half-copied.
export function replaceDir(src: string, dst: string, stagingDir: string): void {
  const id = randomUUID();
  const tag = `${basename(dirname(dst))}.${basename(dst)}`;
  const fresh = join(stagingDir, `${tag}.new-${id}`);
  const old = join(stagingDir, `${tag}.old-${id}`);
  cpSync(src, fresh, { recursive: true });
  const hadDst = existsSync(dst);
  if (hadDst) renameSync(dst, old);
  try {
    renameSync(fresh, dst);
  } catch (e) {
    if (hadDst) renameSync(old, dst);
    throw e;
  }
  if (hadDst) rmSync(old, { recursive: true, force: true });
}

function gitObjectSha(type: 'blob' | 'tree', body: Buffer): Buffer {
  return createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest();
}

// The git tree object id the dir would have if committed, assuming no executable files.
function gitTreeSha(dir: string): Buffer {
  const entries = visibleEntries(dir).map((name) => {
    const abs = join(dir, name);
    const isTree = statSync(abs).isDirectory();
    return { name, isTree, sha: isTree ? gitTreeSha(abs) : gitObjectSha('blob', readFileSync(abs)) };
  });
  // git orders tree entries as if directory names ended in '/'.
  const sortKey = (e: { name: string; isTree: boolean }) => (e.isTree ? `${e.name}/` : e.name);
  entries.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  const body = Buffer.concat(entries.flatMap((e) => [
    Buffer.from(`${e.isTree ? '40000' : '100644'} ${e.name}\0`), e.sha,
  ]));
  return gitObjectSha('tree', body);
}

// True when installedDir is byte-identical to a committed version of relPath; any git failure answers false.
export function matchesPastBundle(repoRoot: string, relPath: string, installedDir: string): boolean {
  try {
    const commits = execFileSync('git', ['-C', repoRoot, 'log', '--format=%H', '--', relPath], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n').filter(Boolean);
    if (commits.length === 0) return false;
    const trees = execFileSync('git', ['-C', repoRoot, 'cat-file', '--batch-check=%(objectname)'], {
      encoding: 'utf8', timeout: 5000, input: `${commits.map((c) => `${c}:${relPath}`).join('\n')}\n`,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).split('\n').filter((l) => /^[0-9a-f]{40}$/.test(l));
    return new Set(trees).has(gitTreeSha(installedDir).toString('hex'));
  } catch {
    return false;
  }
}
