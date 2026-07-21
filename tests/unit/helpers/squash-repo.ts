import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Parent repo on `main` + a linked worktree on `feat/x`. `mainEdit` (if given) is
// committed on main *after* the branch forks, so a squash-merge back collides.
export function makeParentAndWorktree(opts: { mainEdit?: string } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'sq-parent-'));
  const g = (...a: string[]) => execFileSync('git', ['-C', parent, ...a], { encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '-b', 'main', parent]);
  g('config', 'user.email', 't@e'); g('config', 'user.name', 'T');
  writeFileSync(join(parent, 'f.txt'), 'base\n');
  g('add', '.'); g('commit', '-q', '-m', 'seed');

  const wt = mkdtempSync(join(tmpdir(), 'sq-wt-'));
  g('worktree', 'add', '-q', '-b', 'feat/x', wt, 'main');
  writeFileSync(join(wt, 'f.txt'), 'branch change\n');
  execFileSync('git', ['-C', wt, 'commit', '-q', '-am', 'branch work']);

  if (opts.mainEdit) {
    writeFileSync(join(parent, 'f.txt'), opts.mainEdit);
    g('add', '.'); g('commit', '-q', '-m', 'main moved');
  }
  return { parent, wt, g };
}
