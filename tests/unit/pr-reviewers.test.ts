import { describe, it, expect } from 'vitest';
import { isReviewerEntry, reviewersForRepo } from '../../src/git/pr-reviewers.js';

describe('reviewersForRepo', () => {
  const entries = ['livekit/core-services', 'alice'];

  it('requests a team only on repos its org owns', () => {
    expect(reviewersForRepo(entries, 'LiveKit/cloud')).toEqual(['livekit/core-services', 'alice']);
    expect(reviewersForRepo(entries, 'frostbyte73/outpost')).toEqual(['alice']);
    expect(reviewersForRepo(entries, null)).toEqual(['alice']);
  });
});

describe('isReviewerEntry', () => {
  it('accepts logins and org/team slugs, nothing that could read as a flag', () => {
    expect(['alice', 'livekit/core-services', 'org/team.v2'].every(isReviewerEntry)).toBe(true);
    expect(['-x', 'livekit/', 'a/b/c', 'alice,bob', '', 3].some(isReviewerEntry)).toBe(false);
  });
});
