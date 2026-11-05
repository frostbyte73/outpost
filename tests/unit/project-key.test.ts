import { describe, expect, it } from 'vitest';
import { projectKeyFromRemote } from '../../src/storage/project-registry.js';

describe('projectKeyFromRemote', () => {
  it.each([
    ['git@github.com:Owner/Repo.git', 'github.com/owner/repo'],
    ['https://github.com/owner/repo', 'github.com/owner/repo'],
    ['https://github.com/owner/repo.git/', 'github.com/owner/repo'],
    ['ssh://git@github.com:22/owner/repo.git', 'github.com/owner/repo'],
    ['https://user@gitlab.com/group/sub/repo.git\n', 'gitlab.com/group/sub/repo'],
    ['not a url', undefined],
    ['https://github.com/', undefined],
    ['file:///Users/dc/repo', undefined],
  ])('%s → %s', (url, key) => {
    expect(projectKeyFromRemote(url)).toBe(key);
  });
});
