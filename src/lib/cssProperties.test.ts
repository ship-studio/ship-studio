import { describe, expect, it } from 'vitest';
import { suggestValues, isAnimationProperty } from './cssProperties';

describe('isAnimationProperty', () => {
  it('matches animation and animation-name', () => {
    expect(isAnimationProperty('animation')).toBe(true);
    expect(isAnimationProperty('animation-name')).toBe(true);
    expect(isAnimationProperty(' Animation ')).toBe(true);
  });

  it('rejects other properties', () => {
    expect(isAnimationProperty('color')).toBe(false);
    expect(isAnimationProperty('transition')).toBe(false);
  });
});

describe('suggestValues', () => {
  it('suggests @keyframes names first for animation properties', () => {
    const out = suggestValues('animation', ['--accent'], ['reveal', 'spin']);
    expect(out.slice(0, 2)).toEqual(['reveal', 'spin']);
    expect(out).toContain('var(--accent)');
  });

  it('does not suggest animation names for non-animation properties', () => {
    const out = suggestValues('color', ['--accent'], ['reveal']);
    expect(out).not.toContain('reveal');
    expect(out).toContain('var(--accent)');
  });

  it('wraps bare variable names in var()', () => {
    expect(suggestValues('color', ['--accent'])).toContain('var(--accent)');
    expect(suggestValues('color', ['var(--accent)'])).toContain('var(--accent)');
  });
});
