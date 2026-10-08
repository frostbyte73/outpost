import { describe, it, expect } from 'vitest';
import { draftEdit, factsFingerprint, resolveVerdictOutcome } from '../../src/work/draft-verdict.js';
import type { PinnedCall } from '../../src/work/write-draft.js';

const reply = (id: string, body: string): PinnedCall => ({
  id, label: `reply ${id}`, bash: `gh api -X POST repos/o/r/pulls/1/comments/${id}/replies -F body=@/tmp/r${id}.md`,
  files: { [`/tmp/r${id}.md`]: body },
});

describe('draftEdit', () => {
  it('ignores trailing whitespace and line endings', () => {
    expect(draftEdit([reply('1', 'LGTM\n')], [reply('1', 'LGTM  \r\n')])).toBeUndefined();
  });
  it('reports a body change with a diff', () => {
    const e = draftEdit([reply('1', 'Looks correct, nice work.')], [reply('1', 'Nice.')]);
    expect(e?.chars).toBeGreaterThan(0);
    expect(e?.diff).toContain('-Looks correct, nice work.');
    expect(e?.diff).toContain('+Nice.');
  });
  it('treats a re-serialised JSON reply body as unchanged', () => {
    const drafted: PinnedCall = { id: 'c1', bash: 'gh api -X POST repos/o/r/pulls/1/comments/9/replies --input /tmp/r9.json', files: { '/tmp/r9.json': '{"body": "Thanks, fixed."}' } };
    const approved: PinnedCall = { ...drafted, files: { '/tmp/r9.json': '{"body":"Thanks, fixed."}' } };
    expect(draftEdit([drafted], [approved])).toBeUndefined();
  });

  it('ignores whitespace-only edits inside MCP args and /tmp path churn', () => {
    const mcp = (body: string): PinnedCall => ({ id: 'c1', tool: { name: 'mcp__claude_ai_Linear__save_comment', args: { issueId: 'X', body } } });
    expect(draftEdit([mcp('Line one\nLine two')], [mcp('Line one  \r\nLine two ')])).toBeUndefined();
    const at = (path: string): PinnedCall => ({ id: 'c1', bash: `gh api repos/o/r/issues/1/comments --input ${path}`, files: { [path]: '{"body":"x"}' } });
    expect(draftEdit([at('/tmp/a.json')], [at('/tmp/b-edited.json')])).toBeUndefined();
  });

  it('diffs a one-word change in a JSON body as one line, not the whole payload', () => {
    const body = (text: string): PinnedCall => ({ id: 'c1', bash: 'gh api x --input /tmp/r.json', files: { '/tmp/r.json': JSON.stringify({ body: text }) } });
    const e = draftEdit([body('First line.\nThis looks correct to me.\nLast line.')], [body('First line.\nApproved.\nLast line.')]);
    expect(e?.diff).toContain('-This looks correct to me.');
    expect(e?.diff).toContain('+Approved.');
    expect(e?.diff).not.toContain('-First line.');
  });

  it('counts a skipped call as an edit', () => {
    expect(draftEdit([reply('1', 'a'), reply('2', 'b')], [reply('1', 'a')])).toBeDefined();
  });
});

describe('factsFingerprint', () => {
  it('is empty with no PR facts and moves when a watched fact moves', () => {
    expect(factsFingerprint(undefined)).toBe('');
    const a = factsFingerprint({ headRefOid: 'x', mergeable: 'mergeable' });
    expect(factsFingerprint({ headRefOid: 'x', mergeable: 'conflicting' })).not.toBe(a);
    expect(factsFingerprint({ headRefOid: 'x', mergeable: 'mergeable', comments: [] })).toBe(a);
  });

  it('moves on a new PR comment but not on CI settling', () => {
    const c = (id: string) => ({ id, author: 'r', body: 'b', createdAt: 0 });
    const base = factsFingerprint({ headRefOid: 'x', ciState: 'pending', comments: [c('1')] });
    expect(factsFingerprint({ headRefOid: 'x', ciState: 'success', comments: [c('1')] })).toBe(base);
    expect(factsFingerprint({ headRefOid: 'x', ciState: 'pending', comments: [c('1'), c('2')] })).not.toBe(base);
  });
});

describe('resolveVerdictOutcome', () => {
  it('maps edits, skips and staleness', () => {
    const edit = { chars: 3, diff: 'd' };
    expect(resolveVerdictOutcome('accepted', undefined)).toBe('accepted');
    expect(resolveVerdictOutcome('accepted', { edit })).toBe('edited');
    expect(resolveVerdictOutcome('denied', { edit })).toBe('edited');
    expect(resolveVerdictOutcome('accepted', { stale: true })).toBe('accepted');
    expect(resolveVerdictOutcome('accepted', { edit, stale: true })).toBe('superseded');
    expect(resolveVerdictOutcome('denied', { stale: true })).toBe('superseded');
    expect(resolveVerdictOutcome('revised', { stale: true })).toBe('superseded');
    expect(resolveVerdictOutcome('auto-accepted', { edit })).toBe('auto-accepted');
  });
});
