import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Copies the bundled actions into the runtime dir, then hands that dir to the runtime to deliver.
export function ensureActionsInstalled(
  srcRepoDir: string,
  outpostRuntimeDir: string,
  deliver: (actionsDir: string) => void,
): void {
  const dstDir = join(outpostRuntimeDir, 'actions');
  installActions(join(srcRepoDir, 'actions'), dstDir);
  deliver(dstDir);
}

// Copies bundled actions into ~/.outpost/actions so users can edit them.
// Real directories are left alone — user edits survive upgrades. Stale symlinks
// from the old install pattern are replaced with copies.
function installActions(srcDir: string, dstDir: string): void {
  mkdirSync(dstDir, { recursive: true });
  if (!existsSync(srcDir)) return;
  installSharedDocs(srcDir, dstDir);
  for (const category of safeReaddir(srcDir)) {
    const srcCat = join(srcDir, category);
    if (!isDir(srcCat)) continue;
    const dstCat = join(dstDir, category);
    mkdirSync(dstCat, { recursive: true });
    for (const name of safeReaddir(srcCat)) {
      const src = join(srcCat, name);
      if (!isDir(src)) continue;
      const dst = join(dstCat, name);
      let existing: ReturnType<typeof lstatSync> | null = null;
      try { existing = lstatSync(dst); } catch { /* missing */ }
      if (existing) {
        if (existing.isSymbolicLink()) {
          try { unlinkSync(dst); } catch { /* tolerate */ }
        } else {
          continue;
        }
      }
      try {
        cpSync(src, dst, { recursive: true });
        console.log(`[work] installed action: ${dst}`);
      } catch (e) {
        console.warn(`[work] could not install action ${category}/${name}: ${(e as Error).message}`);
      }
    }
  }
  // NOTE: we intentionally do NOT prune here. ~/.outpost/actions is the authoritative,
  // user-editable store (the registry reads it), so it holds user-authored actions that
  // don't exist in the bundled repo — e.g. `write/run-github-workflow`. pruneStaleActions
  // would delete exactly those (any dst action in a repo-defined category the repo lacks),
  // nuking a just-created action on the next ensureActionsInstalled call. Stale *bundled*
  // actions dropped from the repo are handled by the registry's tolerant load + explicit
  // cleanup instead. pruneStaleActions is kept as a manual utility (see its tests).
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
