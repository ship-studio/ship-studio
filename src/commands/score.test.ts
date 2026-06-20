import { describe, it, expect } from 'vitest';
import { scoreMatch } from './score';

describe('scoreMatch', () => {
  it('returns the neutral 0.5 for an empty or whitespace query', () => {
    expect(scoreMatch('', 'home')).toBe(0.5);
    expect(scoreMatch('   ', 'home')).toBe(0.5);
  });

  it('scores an exact title match as 1.0', () => {
    expect(scoreMatch('home', 'home')).toBe(1);
    expect(scoreMatch('HOME', 'Home')).toBe(1); // case-insensitive
  });

  it('scores a prefix match as 0.95', () => {
    expect(scoreMatch('hom', 'home')).toBe(0.95);
  });

  it('scores a word-boundary match as 0.85', () => {
    expect(scoreMatch('serv', 'Restart dev server')).toBe(0.85);
  });

  it('scores an initials / acronym match as 0.75', () => {
    expect(scoreMatch('rds', 'Restart Dev Server')).toBe(0.75);
  });

  it('requires at least 2 chars for the initials path', () => {
    // Single-char query never reaches the initials branch; "d" matches the
    // "Dev" word boundary instead of the "rds" acronym.
    expect(scoreMatch('d', 'Restart Dev Server')).toBe(0.85);
  });

  it('scores a bare substring hit as 0.6', () => {
    expect(scoreMatch('est', 'test')).toBe(0.6);
  });

  it('caps keyword-only matches at 0.5 so the title always wins', () => {
    // No hit on the title, but the keyword prefixes -> would be 0.95, capped.
    expect(scoreMatch('foo', 'Unrelated title', ['foobar'])).toBe(0.5);
    // Even an exact keyword match is capped.
    expect(scoreMatch('deploy', 'Unrelated title', ['deploy'])).toBe(0.5);
  });

  it('returns 0 when nothing matches', () => {
    expect(scoreMatch('zzz', 'home')).toBe(0);
    expect(scoreMatch('zzz', 'home', ['nope', 'never'])).toBe(0);
  });
});
