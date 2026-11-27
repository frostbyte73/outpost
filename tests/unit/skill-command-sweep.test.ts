import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { Allowlist } from '../../src/permissions/allowlist.js';
import { ActionRegistry } from '../../src/actions/index.js';
import groups from '../../config/permission-groups.default.json' with { type: 'json' };
import globalAllowlist from '../../config/allowlist.default.json' with { type: 'json' };

const root = join(import.meta.dirname, '../..');
const registry = new ActionRegistry(join(root, 'actions'), { permissionGroups: groups });
const load = registry.load();
const al = new Allowlist(globalAllowlist, { actionRegistry: registry });

// A rule that denies what its own SKILL.md instructs stalls that action forever: an
// action-bound session gets no approval prompt, it just fails and journals a blocker. These
// are the real, placeholder-substituted forms of the commands the shipped SKILLs document.
const CASES: Array<[string, string]> = [
  ['code.fix-ci', 'gh run view 8123456 --log-failed'],
  ['code.merge-pr', 'gh pr merge 12 --squash'],
  ['code.orchestrate-review', 'git fetch origin main'],
  ['code.post-pr-review', 'gh api --method POST "repos/{owner}/{repo}/pulls/12/reviews" --input /tmp/outpost-review-12.json'],
  ['code.reply-pr-comments', 'gh api "repos/{owner}/{repo}/pulls/12/comments" --paginate --jq \'.[] | "\\(.node_id)"\''],
  ['code.reply-pr-comments', 'gh pr comment 12 --body-file /tmp/outpost-reply-9.md'],
  ['code.fix-ci', 'gh pr checks 12 --watch=false  # one shot, no polling'],
  ['code.resolve-conflicts', 'git fetch origin'],
  // Ship 5 re-review: the SKILL.md was rewritten to write the base ref literally into the
  // merge command rather than through a shell variable — `git merge "$BASE"` let a
  // flag-shaped `boundNote` override (`-s ours`, `-Xtheirs`) reach git as a merge option,
  // which quoting the variable does nothing to stop. This is the corrected literal form.
  ['code.resolve-conflicts', 'git merge origin/main'],
  ['code.submit-pr-verdict', 'gh pr review 12 --approve --body-file /tmp/outpost-verdict-12.md'],
  ['write.add-project', 'gh repo clone acme/example /Users/testuser/acme/example'],
  ['write.add-project', 'git clone https://github.com/acme/example.git /Users/testuser/acme/example'],
  ['write.add-project', 'mkdir -p /Users/testuser/acme'],
  ['write.add-project', 'git -C /Users/testuser/acme/example log -1 --oneline'],
  ['write.create-repo', 'git clone git@github.com:frostbyte73/game.git /Users/testuser/github/frostbyte73/game'],
  ['write.create-repo', 'git clone https://github.com/frostbyte73/game.git /Users/testuser/github/frostbyte73/game'],
  ['write.create-repo', 'mkdir -p /Users/testuser/github/frostbyte73'],
  ['write.create-repo', 'curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user'],
  ['write.create-repo', 'git -C /Users/testuser/github/frostbyte73/game log -1 --oneline'],
  ['write.create-repo', 'git -C /Users/testuser/github/frostbyte73/game branch --show-current'],
  ['write.create-repo', 'git -C /Users/testuser/github/frostbyte73/game remote get-url origin'],
  ['write.create-repo', 'which gh'],
  ['write.create-repo', 'gh repo view frostbyte73/game --json nameWithOwner,isPrivate,url,defaultBranchRef'],
  ['write.create-repo', 'curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/repos/frostbyte73/game'],
  ['write.create-repo', 'curl -fsS -X POST "$OUTPOST_API_URL/api/projects" \\\n  -H \'content-type: application/json\' \\\n  -d \'{"cwd":"/Users/testuser/github/frostbyte73/game"}\''],
  ['write.run-github-workflow', 'gh workflow run "deploy.yml" --ref "main"'],
  ['write.run-github-workflow', 'gh run watch 8123456 --interval 60 --exit-status'],
];

describe('the real substituted form of every documented SKILL command', () => {
  it('is permitted by its own action grant', async () => {
    await load;
    const denied = CASES.filter(([a, c]) => !al.allows('Bash', { command: c }, undefined, a));
    expect(denied.map(([a, c]) => `${a}: ${c}`)).toEqual([]);
  });
});

// The /api/projects POST is ungated, so its unquoted values must not carry a shell operator.
describe('write.create-repo register POST', () => {
  it('denies an unquoted value carrying a shell operator', async () => {
    await load;
    const base = 'curl -fsS -X POST "$OUTPOST_API_URL/api/projects"';
    for (const c of [`${base} -d x;id`, `${base} -H x>y`, `${base} -d x|sh`, `${base} -d x&id`]) {
      expect(al.allows('Bash', { command: c }, undefined, 'write.create-repo'), c).toBe(false);
    }
  });
});
