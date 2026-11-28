import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ActionRevisionsStore } from '../storage/action-revisions-store.js';
import {
  STAGING_DIR, bundleHash, matchesPastBundle, readBundleState, replaceDir, writeBundleState,
} from './bundle-sync.js';

// Bundled actions the repo dropped. Installing never deletes on its own (see the NOTE in
// installActions), so these are removed explicitly, or set aside under `.retired/` if edited.
const RETIRED_ACTIONS = ['meta/wait'] as const;

// Copies the bundled actions into the runtime dir, then hands that dir to the runtime to deliver.
export function ensureActionsInstalled(
  srcRepoDir: string,
  outpostRuntimeDir: string,
  deliver: (actionsDir: string) => void,
  revisions: ActionRevisionsStore,
): void {
  installActions(srcRepoDir, outpostRuntimeDir, revisions);
  deliver(join(outpostRuntimeDir, 'actions'));
}

// Updates untouched bundled copies, keeps user-edited ones, and reports those the repo has moved past.
function installActions(srcRepoDir: string, runtimeDir: string, revisions: ActionRevisionsStore): void {
  const srcDir = join(srcRepoDir, 'actions');
  const dstDir = join(runtimeDir, 'actions');
  mkdirSync(dstDir, { recursive: true });
  if (!existsSync(srcDir)) return;
  installSharedDocs(srcDir, dstDir);
  const stagingDir = join(runtimeDir, STAGING_DIR);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  const baselines = { ...readBundleState(runtimeDir).baselines };
  const editedLocally: string[] = [];
  for (const category of safeReaddir(srcDir)) {
    const srcCat = join(srcDir, category);
    if (!isDir(srcCat)) continue;
    const dstCat = join(dstDir, category);
    mkdirSync(dstCat, { recursive: true });
    for (const name of safeReaddir(srcCat)) {
      const src = join(srcCat, name);
      if (!isDir(src)) continue;
      const key = `${category}/${name}`;
      try {
        const outcome = syncAction(src, join(dstCat, name), key, baselines[key], srcRepoDir, stagingDir, revisions);
        if (outcome === 'edited') {
          editedLocally.push(`${category}.${name}`);
          console.log(`[work] action ${key} edited locally — not updated (repo differs)`);
        } else if (outcome !== 'kept') {
          baselines[key] = outcome;
        }
      } catch (e) {
        console.warn(`[work] could not install action ${key}: ${(e as Error).message}`);
      }
    }
  }
  retireActions(srcRepoDir, dstDir, baselines);
  try {
    writeBundleState(runtimeDir, { version: 1, baselines, editedLocally });
  } catch (e) {
    console.warn(`[work] could not record installed action bundles: ${(e as Error).message}`);
  }
  // NOTE: we intentionally do NOT prune here. ~/.outpost/actions is the authoritative,
  // user-editable store (the registry reads it), so it holds user-authored actions that
  // don't exist in the bundled repo — e.g. `write/run-github-workflow`. pruneStaleActions
  // would delete exactly those (any dst action in a repo-defined category the repo lacks),
  // nuking a just-created action on the next ensureActionsInstalled call. Stale *bundled*
  // actions dropped from the repo are handled by the registry's tolerant load + explicit
  // cleanup instead. pruneStaleActions is kept as a manual utility (see its tests).
}

// Returns the new baseline hash, or 'edited'/'kept' for a user-edited copy with/without a newer bundle.
function syncAction(
  src: string,
  dst: string,
  key: string,
  baseline: string | undefined,
  srcRepoDir: string,
  stagingDir: string,
  revisions: ActionRevisionsStore,
): string | 'edited' | 'kept' {
  const repoHash = bundleHash(src);
  let existing: ReturnType<typeof lstatSync> | null = null;
  try { existing = lstatSync(dst); } catch { /* missing */ }
  if (existing?.isSymbolicLink()) {
    unlinkSync(dst);
    existing = null;
  }
  if (!existing) {
    replaceDir(src, dst, stagingDir);
    console.log(`[work] installed action: ${dst}`);
    return repoHash;
  }
  const installedHash = bundleHash(dst);
  // Before the baseline check, so a crash between the swap and the state write re-seeds, not reports.
  if (installedHash === repoHash) return repoHash;
  const unedited = baseline ? installedHash === baseline : matchesPastBundle(srcRepoDir, `actions/${key}`, dst);
  if (!unedited) return baseline === repoHash ? 'kept' : 'edited';
  const before = readSkillMd(dst);
  replaceDir(src, dst, stagingDir);
  console.log(`[work] updated action: ${dst}`);
  const after = readSkillMd(dst);
  try {
    if (after !== undefined) revisions.noteBundleUpdate({ action: key.replace('/', '.'), before, after });
  } catch (e) {
    console.warn(`[work] could not record revision for ${key}: ${(e as Error).message}`);
  }
  return repoHash;
}

// Same unedited test as syncAction: the recorded baseline, else any version the repo ever shipped.
function retireActions(srcRepoDir: string, dstDir: string, baselines: Record<string, string>): void {
  for (const key of RETIRED_ACTIONS) {
    const dst = join(dstDir, key);
    try {
      if (isDir(dst)) {
        const baseline = baselines[key];
        const unedited = baseline ? bundleHash(dst) === baseline : matchesPastBundle(srcRepoDir, `actions/${key}`, dst);
        if (unedited) {
          rmSync(dst, { recursive: true, force: true });
          console.log(`[work] retired action ${key}: removed`);
        } else {
          const kept = join(dstDir, '.retired', key);
          rmSync(kept, { recursive: true, force: true });
          mkdirSync(dirname(kept), { recursive: true });
          renameSync(dst, kept);
          console.log(`[work] retired action ${key}: edited locally — moved to .retired/${key}`);
        }
      }
      delete baselines[key];
    } catch (e) {
      console.warn(`[work] could not retire action ${key}: ${(e as Error).message}`);
    }
  }
}

function readSkillMd(dir: string): string | undefined {
  try { return readFileSync(join(dir, 'SKILL.md'), 'utf8'); } catch { return undefined; }
}

// SHARED-*.md are overwritten every boot, unlike actions: no proposal flow edits them,
// so the repo copy is always the current one.
function installSharedDocs(srcDir: string, dstDir: string): void {
  for (const f of safeReaddir(srcDir)) {
    if (!f.startsWith('SHARED-') || !f.endsWith('.md')) continue;
    try {
      cpSync(join(srcDir, f), join(dstDir, f));
    } catch (e) {
      console.warn(`[work] could not install ${f}: ${(e as Error).message}`);
    }
  }
}

// After a repo action dir disappears (e.g. renamed), remove the stale copy under
// dstDir and whatever the runtime delivered for it so the dead action stops appearing in the
// catalog. Only prunes within categories the repo source still defines — an
// action's whole category, or anything at all, is left alone if srcDir is
// missing or empty (defense against wiping installs on a bad path).
export function pruneStaleActions(
  srcDir: string,
  dstDir: string,
  pruneDelivered: (category: string, name: string, ownedRoot: string) => void,
): void {
  const srcCategories = safeReaddir(srcDir).filter((c) => isDir(join(srcDir, c)));
  if (srcCategories.length === 0) return;
  const ownedRoot = resolve(dstDir);

  for (const category of srcCategories) {
    const srcCat = join(srcDir, category);
    const dstCat = join(dstDir, category);
    if (!isDir(dstCat)) continue;
    for (const name of safeReaddir(dstCat)) {
      const dst = join(dstCat, name);
      if (!isDir(dst)) continue;
      if (existsSync(join(srcCat, name))) continue;
      try {
        rmSync(dst, { recursive: true, force: true });
        console.log(`[work] pruned stale action: ${dst}`);
      } catch (e) {
        console.warn(`[work] could not prune stale action ${category}/${name}: ${(e as Error).message}`);
        continue;
      }
      pruneDelivered(category, name, ownedRoot);
    }
  }
}

export function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
export function isDir(p: string): boolean {
  try { return lstatSync(p).isDirectory(); } catch { return false; }
}

// Bundled repo paths, for daemon.ts to pass into ensureActionsInstalled.
export function bundledRepoDir(srcDir: string): string {
  return join(srcDir, '..');
}
