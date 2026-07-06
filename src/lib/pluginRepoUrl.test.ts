/**
 * Tests for repo-URL normalization used to match registry entries against
 * installed plugins (fixes the "Install" loop when the registry slug and the
 * manifest id disagree).
 */

import { describe, expect, it } from 'vitest';
import { normalizeRepoUrl, repoUrlsMatch } from './pluginRepoUrl';

describe('normalizeRepoUrl', () => {
  it('strips a trailing .git and trailing slashes', () => {
    expect(normalizeRepoUrl('https://github.com/owner/repo.git')).toBe('github.com/owner/repo');
    expect(normalizeRepoUrl('https://github.com/owner/repo/')).toBe('github.com/owner/repo');
    expect(normalizeRepoUrl('https://github.com/owner/repo.git/')).toBe('github.com/owner/repo');
    expect(normalizeRepoUrl('  https://github.com/owner/repo  ')).toBe('github.com/owner/repo');
  });

  it('lower-cases the host but not the path', () => {
    expect(normalizeRepoUrl('https://GitHub.COM/Owner/Repo')).toBe('github.com/Owner/Repo');
  });

  it('folds scp-style and ssh remotes into host/path', () => {
    expect(normalizeRepoUrl('git@github.com:owner/repo.git')).toBe('github.com/owner/repo');
    expect(normalizeRepoUrl('ssh://git@github.com/owner/repo.git')).toBe('github.com/owner/repo');
    expect(normalizeRepoUrl('git://github.com/owner/repo')).toBe('github.com/owner/repo');
  });

  it('does not treat an @ in the path as a user', () => {
    expect(normalizeRepoUrl('https://github.com/owner/repo@v2')).toBe('github.com/owner/repo@v2');
  });
});

describe('repoUrlsMatch', () => {
  it('matches equivalent https / ssh / .git-suffixed forms', () => {
    expect(
      repoUrlsMatch(
        'https://github.com/ship-studio/plugin-figma',
        'git@github.com:ship-studio/plugin-figma.git'
      )
    ).toBe(true);
    expect(
      repoUrlsMatch(
        'https://github.com/ship-studio/plugin-figma/',
        'HTTPS://GITHUB.com/ship-studio/plugin-figma.git'
      )
    ).toBe(true);
  });

  it('does not match different repos', () => {
    expect(
      repoUrlsMatch(
        'https://github.com/ship-studio/plugin-figma',
        'https://github.com/ship-studio/plugin-vercel'
      )
    ).toBe(false);
  });

  it('never matches empty or missing URLs (dev plugins)', () => {
    expect(repoUrlsMatch('', '')).toBe(false);
    expect(repoUrlsMatch(undefined, 'https://github.com/a/b')).toBe(false);
    expect(repoUrlsMatch('https://github.com/a/b', null)).toBe(false);
  });
});
