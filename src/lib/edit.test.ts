import { describe, expect, it } from 'vitest';
import { scaleValue, steppedScale, SPACING_CONTROLS } from './edit';

describe('scaleValue', () => {
  it('reads <prefix>-N for the requested utility', () => {
    expect(scaleValue('bg-white p-10 flex', 'p')).toBe(10);
    expect(scaleValue('m-4 p-2', 'm')).toBe(4);
    expect(scaleValue('flex gap-6', 'gap')).toBe(6);
    expect(scaleValue('p-0', 'p')).toBe(0);
  });

  it('does not confuse prefixes (p vs px vs m)', () => {
    expect(scaleValue('px-4 py-2', 'p')).toBeNull(); // px/py are not p
    expect(scaleValue('mx-3', 'm')).toBeNull(); // mx is not m
  });

  it('ignores arbitrary and absent values', () => {
    expect(scaleValue('p-[22px]', 'p')).toBeNull();
    expect(scaleValue('flex gap-2', 'p')).toBeNull();
  });
});

describe('steppedScale', () => {
  it('steps by one integer with no skips (regression: 8→9→10)', () => {
    expect(steppedScale('p-8 flex', 'p', 1)).toBe('p-9');
    expect(steppedScale('p-9 flex', 'p', 1)).toBe('p-10');
    expect(steppedScale('p-10 flex', 'p', -1)).toBe('p-9');
    expect(steppedScale('m-3', 'm', 1)).toBe('m-4');
    expect(steppedScale('gap-5', 'gap', -1)).toBe('gap-4');
  });

  it('clamps at 0 and treats absent as 0', () => {
    expect(steppedScale('p-0', 'p', -1)).toBe('p-0');
    expect(steppedScale('flex', 'm', -1)).toBe('m-0');
    expect(steppedScale('flex', 'gap', 1)).toBe('gap-1');
  });
});

describe('SPACING_CONTROLS', () => {
  it('maps each kind to a Tailwind prefix and a CSS property', () => {
    expect(SPACING_CONTROLS.map((c) => c.kind)).toEqual(['padding', 'margin', 'gap']);
    expect(SPACING_CONTROLS.find((c) => c.kind === 'padding')).toMatchObject({
      prefix: 'p',
      css: 'padding',
    });
    expect(SPACING_CONTROLS.find((c) => c.kind === 'gap')).toMatchObject({
      prefix: 'gap',
      css: 'gap',
    });
  });
});
