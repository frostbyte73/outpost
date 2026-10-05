import { describe, it, expect } from 'vitest';
import { classifyDraft, prNumberOf, type ClassifyContext } from '../../src/work/preapproval-classify.js';
import { effectivePreapprovals } from '../../src/work/preapprovals.js';
import { writeFindings } from '../../src/permissions/dangerous-writes.js';
import type { PinnedCall } from '../../src/work/write-draft.js';

const ALL = effectivePreapprovals({ push: true, openPr: true, replies: true, merge: true });

function ctx(over: Partial<ClassifyContext> = {}): ClassifyContext {
  return {
    pre: ALL, branch: 'deps/bump-ws', baseBranch: 'main', prNumber: 42,
    commentIds: new Set([1001]), ...over,
  };
}

const call = (bash: string, i = 0): PinnedCall => ({ id: `c${i}`, label: `call ${i}`, bash });

const SHA = 'a'.repeat(40);
const covered = {
  commitM: 'git commit -m "bump ws"',
  commitF: 'git commit -F /tmp/outpost-commit.txt',
  push: 'git push -u origin deps/bump-ws',
  pushHead: 'git push origin HEAD:deps/bump-ws',
  prCreate: 'gh pr create --title "Bump ws" --body-file /tmp/b.md --base main --head deps/bump-ws',
  replyApi: 'gh api --method POST "repos/{owner}/{repo}/pulls/42/comments/1001/replies" --input /tmp/outpost-reply-1.json',
  prComment: 'gh pr comment 42 --body-file /tmp/outpost-reply-2.md',
  merge: `gh pr merge 42 --squash --match-head-commit ${SHA}`,
  mergeCleanedMessage: `gh pr merge 42 --squash --subject "Bump ws (#42)" --body-file /tmp/merge-body.txt --match-head-commit ${SHA}`,
  deleteBranch: 'git push origin --delete deps/bump-ws',
  deleteBranchSeparated: 'git push origin --delete -- "deps/bump-ws"',
};

describe('the canonical shapes', () => {
  it.each(Object.entries(covered))('covers %s', (_name, bash) => {
    expect(classifyDraft([call(bash)], ctx())).toMatchObject({ covered: true });
  });

  it('reports the merge sha so the readiness check can compare it', () => {
    expect(classifyDraft([call(covered.merge)], ctx())).toEqual({ covered: true, settings: ['merge'], mergeSha: SHA });
  });

  // Pins the expected-findings table against the real finding codes, so a rename in
  // dangerous-writes.ts fails here rather than silently turning every merge into a miss.
  it('expects exactly the findings the real classifier raises', () => {
    expect(writeFindings(covered.replyApi).map((f) => f.code)).toEqual(['api-write']);
    expect(writeFindings(covered.merge).map((f) => f.code)).toEqual(['pr-merge']);
    expect(writeFindings(covered.deleteBranch).map((f) => f.code)).toEqual(['delete-ref']);
    expect(writeFindings('git push origin main').map((f) => f.code)).toEqual(['default-branch']);
  });
});

describe('a setting that is off', () => {
  it('leaves its shapes uncovered and says which setting', () => {
    const res = classifyDraft([call(covered.prCreate)], ctx({ pre: effectivePreapprovals({ push: true }) }));
    expect(res).toEqual({ covered: false, reason: expect.stringContaining('openPr') });
  });
});

describe('near misses', () => {
  const misses: Record<string, string> = {
    'another branch': 'git push origin some/other-branch',
    'the base branch without direct landing': 'git push origin HEAD:main',
    'a force push': 'git push --force origin deps/bump-ws',
    'a clustered force flag': 'git push -fu origin deps/bump-ws',
    'an amend': 'git commit --amend -m x',
    'a commit message file outside /tmp': 'git commit -F /etc/passwd',
    'a foreign repo PR': 'gh pr create --repo other/org --base main --head deps/bump-ws --title t --body b',
    'a PR from another head': 'gh pr create --base main --head main --title t --body b',
    'a PR against another base': 'gh pr create --base release --head deps/bump-ws --title t --body b',
    'a reply on another PR': 'gh api --method POST "repos/{owner}/{repo}/pulls/7/comments/1001/replies" --input /tmp/r.json',
    'a reply to a comment not on this PR': 'gh api --method POST "repos/{owner}/{repo}/pulls/42/comments/999/replies" --input /tmp/r.json',
    'a reply on a literal repo': 'gh api --method POST "repos/livekit/x/pulls/42/comments/1001/replies" --input /tmp/r.json',
    'a merge without match-head-commit': 'gh pr merge 42 --squash',
    'a merge of another PR': `gh pr merge 7 --squash --match-head-commit ${SHA}`,
    'an admin merge': `gh pr merge 42 --squash --admin --match-head-commit ${SHA}`,
    'a merge body file outside /tmp': `gh pr merge 42 --squash --body-file /etc/passwd --match-head-commit ${SHA}`,
    'deleting another branch': 'git push origin --delete main',
    'a shell variable': 'git push origin --delete "$BRANCH"',
    'a compound command': 'git push origin deps/bump-ws && gh pr create --base main --head deps/bump-ws --title t --body b',
    'an unrelated write': 'gh issue comment 5 --body hi',
  };
  it.each(Object.entries(misses))('does not cover %s', (_name, bash) => {
    expect(classifyDraft([call(bash)], ctx())).toMatchObject({ covered: false });
  });

  it('does not cover an MCP call', () => {
    const mcp: PinnedCall = { id: 'm', tool: { name: 'mcp__claude_ai_Linear__save_comment', args: {} } };
    expect(classifyDraft([mcp], ctx())).toMatchObject({ covered: false });
  });

  it('does not cover replies or merge on a step with no PR yet', () => {
    expect(classifyDraft([call(covered.prComment)], ctx({ prNumber: undefined }))).toMatchObject({ covered: false });
  });
});

describe('a step whose own branch is the base', () => {
  const onBase = ctx({ branch: 'staging', baseBranch: 'staging' });
  it('never covers pushing or deleting it', () => {
    expect(classifyDraft([call('git push -u origin staging')], onBase)).toMatchObject({ covered: false });
    expect(classifyDraft([call('git push origin --delete staging')], onBase)).toMatchObject({ covered: false });
  });
});

describe('PR numbers', () => {
  it.each(['42.0', '0x2a', '4.2e1', '+42'])('does not read %s as PR 42', (n) => {
    expect(classifyDraft([call(`gh pr merge ${n} --squash --match-head-commit ${SHA}`)], ctx())).toMatchObject({ covered: false });
    expect(classifyDraft([call(`gh pr comment ${n} --body-file /tmp/r.md`)], ctx())).toMatchObject({ covered: false });
  });
});

describe('direct landing', () => {
  const direct = effectivePreapprovals({ push: true, landing: 'direct' });
  it('covers a push of HEAD to the base branch', () => {
    expect(classifyDraft([call('git push origin HEAD:main')], ctx({ pre: direct }))).toMatchObject({ covered: true });
  });
  it('does not cover it without push', () => {
    expect(classifyDraft([call('git push origin HEAD:main')], ctx({ pre: effectivePreapprovals({ landing: 'direct' }) })))
      .toMatchObject({ covered: false });
  });
});

describe('a mixed draft', () => {
  it('is uncovered as a whole when any one call is uncovered, naming that call', () => {
    const res = classifyDraft([call(covered.push, 0), call('gh issue comment 5 --body hi', 1)], ctx());
    expect(res).toEqual({ covered: false, reason: expect.stringContaining('call 1') });
  });

  it('collects every setting a covered draft used', () => {
    const res = classifyDraft([call(covered.commitF, 0), call(covered.push, 1), call(covered.prCreate, 2)], ctx());
    expect(res).toEqual({ covered: true, settings: ['push', 'openPr'] });
  });
});

describe('prNumberOf', () => {
  it('reads the number off a PR url', () => {
    expect(prNumberOf('https://github.com/livekit/egress/pull/1411')).toBe(1411);
    expect(prNumberOf(undefined)).toBeUndefined();
    expect(prNumberOf('https://github.com/livekit/egress/issues/3')).toBeUndefined();
  });
});
