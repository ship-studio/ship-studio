import { describe, expect, it } from 'vitest';
import { parseNumericValue, formatNumericValue } from './cssProperties';

describe('parseNumericValue', () => {
  it('parses a number with a unit', () => {
    expect(parseNumericValue('24px')).toEqual({ num: 24, unit: 'px', decimals: 0 });
    expect(parseNumericValue('1.5rem')).toEqual({ num: 1.5, unit: 'rem', decimals: 1 });
    expect(parseNumericValue('-10%')).toEqual({ num: -10, unit: '%', decimals: 0 });
    expect(parseNumericValue('.5em')).toEqual({ num: 0.5, unit: 'em', decimals: 1 });
  });

  it('parses a bare number (no unit)', () => {
    expect(parseNumericValue('50')).toEqual({ num: 50, unit: '', decimals: 0 });
    expect(parseNumericValue('0.25')).toEqual({ num: 0.25, unit: '', decimals: 2 });
  });

  it('rejects anything that is not a single number', () => {
    for (const v of [
      '0 auto',
      '1px solid red',
      'calc(100% - 8px)',
      'var(--x)',
      'red',
      '',
      '10px ',
    ]) {
      // a trailing space is trimmed, so '10px ' is valid; test genuinely-multi values
      if (v === '10px ') {
        expect(parseNumericValue(v)).not.toBeNull();
      } else {
        expect(parseNumericValue(v)).toBeNull();
      }
    }
  });
});

describe('formatNumericValue', () => {
  it('re-attaches the unit and trims float noise', () => {
    expect(formatNumericValue(30, 'px', 0)).toBe('30px');
    expect(formatNumericValue(24.0, 'px', 0)).toBe('24px');
    expect(formatNumericValue(1.5, 'rem', 1)).toBe('1.5rem');
    expect(formatNumericValue(2.0, 'rem', 1)).toBe('2rem'); // trailing zero dropped
    expect(formatNumericValue(50, '', 0)).toBe('50');
  });
});
