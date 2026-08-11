import { describe, it, expect } from 'vitest';
import { sanitizeBranchName } from './branches';

describe('sanitizeBranchName', () => {
  it('passes an already-valid name through unchanged', () => {
    expect(sanitizeBranchName('adjust-h2')).toBe('adjust-h2');
    expect(sanitizeBranchName('julian/feature-x')).toBe('julian/feature-x');
    expect(sanitizeBranchName('release-1.2.3')).toBe('release-1.2.3');
  });

  it('converts a space to a dash', () => {
    expect(sanitizeBranchName('adjust h2')).toBe('adjust-h2');
  });

  it('collapses runs of whitespace into a single dash', () => {
    expect(sanitizeBranchName('fix   the   header')).toBe('fix-the-header');
    expect(sanitizeBranchName('fix\tthe\theader')).toBe('fix-the-header');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeBranchName('  adjust h2  ')).toBe('adjust-h2');
  });

  it('strips characters invalid in git refs', () => {
    expect(sanitizeBranchName('what?is*this')).toBe('whatisthis');
    expect(sanitizeBranchName('a~b^c:d')).toBe('abcd');
    expect(sanitizeBranchName('a[b]c\\d')).toBe('abcd');
  });

  it('strips the invalid "@{" sequence', () => {
    expect(sanitizeBranchName('foo@{bar')).toBe('foobar');
  });

  it('collapses ".." runs into a single dot', () => {
    expect(sanitizeBranchName('release..notes')).toBe('release.notes');
    expect(sanitizeBranchName('a...b')).toBe('a.b');
  });

  it('collapses repeated dashes and slashes', () => {
    expect(sanitizeBranchName('a - b')).toBe('a-b');
    expect(sanitizeBranchName('feat//thing')).toBe('feat/thing');
  });

  it('strips leading and trailing slashes and dots', () => {
    expect(sanitizeBranchName('/feature/')).toBe('feature');
    expect(sanitizeBranchName('.hidden.')).toBe('hidden');
    expect(sanitizeBranchName('//a/b//')).toBe('a/b');
  });

  it('strips leading dashes (issue #247 repro — git rejects refs starting with "-")', () => {
    expect(sanitizeBranchName('-test')).toBe('test');
    expect(sanitizeBranchName('--force')).toBe('force');
    expect(sanitizeBranchName('-./fix')).toBe('fix');
    expect(sanitizeBranchName('---')).toBe('');
  });

  it('strips a trailing ".lock"', () => {
    expect(sanitizeBranchName('mybranch.lock')).toBe('mybranch');
    // exposed after collapsing ".." → "."
    expect(sanitizeBranchName('mybranch..lock')).toBe('mybranch');
  });

  it('returns an empty string when nothing salvageable remains', () => {
    expect(sanitizeBranchName('')).toBe('');
    expect(sanitizeBranchName('   ')).toBe('');
    expect(sanitizeBranchName('...')).toBe('');
    expect(sanitizeBranchName('///')).toBe('');
    expect(sanitizeBranchName('~^:?*')).toBe('');
  });

  it('handles the issue #166 repro', () => {
    expect(sanitizeBranchName('adjust h2')).toBe('adjust-h2');
  });

  // Issue #636: free-text-derived names blew past GitHub's 255-byte ref limit
  // (GH005) and the push failure was misreported as a push race.
  describe('length cap', () => {
    it('caps long names at 120 bytes without leaving trailing junk', () => {
      const longInput =
        'Facebook did not provide video data. Open Facebook in the selected browser (chrome), ' +
        'sign in, and confirm this video plays there, then retry. The video may also be private, ' +
        'age restricted, deleted, or unavailable in this account/region';
      const result = sanitizeBranchName(longInput);
      expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(120);
      expect(result.length).toBeGreaterThan(0);
      // No trailing separator left at the cut point.
      expect(result).not.toMatch(/[-/.]$/);
    });

    it('leaves names at or under the cap untouched', () => {
      const exact = 'a'.repeat(120);
      expect(sanitizeBranchName(exact)).toBe(exact);
    });

    it('counts bytes, not characters, and never splits a multi-byte character', () => {
      // é is 2 bytes in UTF-8 → 100 chars = 200 bytes, over the cap.
      const result = sanitizeBranchName('é'.repeat(100));
      const bytes = new TextEncoder().encode(result).length;
      expect(bytes).toBeLessThanOrEqual(120);
      // Round-trips cleanly — no U+FFFD from a half-cut sequence.
      expect(result).not.toContain('�');
      expect(result).toBe('é'.repeat(result.length));
    });
  });
});
