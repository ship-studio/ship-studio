import { describe, expect, it } from 'vitest';
import { paddingValue, steppedPadding } from './edit';

describe('paddingValue', () => {
  it('reads p-N from a class string', () => {
    expect(paddingValue('bg-white p-10 flex')).toBe(10);
    expect(paddingValue('p-0')).toBe(0);
  });
  it('ignores non-padding and arbitrary values', () => {
    expect(paddingValue('px-4 py-2 mx-3')).toBeNull();
    expect(paddingValue('p-[22px]')).toBeNull();
    expect(paddingValue('flex gap-2')).toBeNull();
  });
});

describe('steppedPadding', () => {
  it('steps by one integer with no skips (regression: 8→9→10, never jumps to 10)', () => {
    expect(steppedPadding('p-8 flex', 1)).toBe('p-9');
    expect(steppedPadding('p-9 flex', 1)).toBe('p-10');
    expect(steppedPadding('p-10 flex', -1)).toBe('p-9');
    // Values an old sparse scale would have collapsed or skipped:
    expect(steppedPadding('p-3', 1)).toBe('p-4');
    expect(steppedPadding('p-5', -1)).toBe('p-4');
    expect(steppedPadding('p-7', 1)).toBe('p-8');
  });

  it('clamps at 0', () => {
    expect(steppedPadding('p-0', -1)).toBe('p-0');
    expect(steppedPadding('p-1', -1)).toBe('p-0');
  });

  it('treats no padding as 0', () => {
    expect(steppedPadding('flex gap-2', 1)).toBe('p-1');
    expect(steppedPadding('flex gap-2', -1)).toBe('p-0');
  });
});
