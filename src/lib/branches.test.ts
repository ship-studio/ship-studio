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
});
