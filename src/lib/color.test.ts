import { describe, it, expect } from 'vitest';
import { toHex, visibleHex, toRgba, rgbaToCss, toCss, toFormat } from './color';

describe('toHex', () => {
  it('normalizes named / rgb colors to 6-digit hex', () => {
    expect(toHex('#ff0000')).toBe('#ff0000');
    expect(toHex('red')).toBe('#ff0000');
    expect(toHex('rgb(0, 255, 0)')).toBe('#00ff00');
  });

  it('returns null for unparseable input', () => {
    expect(toHex('var(--brand)')).toBeNull();
  });
});

describe('visibleHex', () => {
  it('returns hex for an opaque color', () => {
    expect(visibleHex('#3366ff')).toBe('#3366ff');
  });

  it('returns null for fully transparent or unparseable colors', () => {
    expect(visibleHex('transparent')).toBeNull();
    expect(visibleHex('rgba(0, 0, 0, 0)')).toBeNull();
    expect(visibleHex('var(--x)')).toBeNull();
  });
});

describe('toRgba', () => {
  it('converts a hex color to clamped 0-255 channels', () => {
    expect(toRgba('#ff0000')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it('preserves alpha from an rgba color', () => {
    expect(toRgba('rgba(0, 128, 255, 0.5)')).toEqual({ r: 0, g: 128, b: 255, a: 0.5 });
  });

  it('falls back to opaque black for unparseable input', () => {
    expect(toRgba('not-a-color')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });
});

describe('rgbaToCss', () => {
  it('emits rgb() when fully opaque', () => {
    expect(rgbaToCss({ r: 1, g: 2, b: 3, a: 1 })).toBe('rgb(1, 2, 3)');
  });

  it('emits rgba() with 3dp-rounded alpha when translucent', () => {
    expect(rgbaToCss({ r: 1, g: 2, b: 3, a: 0.5 })).toBe('rgba(1, 2, 3, 0.5)');
    expect(rgbaToCss({ r: 1, g: 2, b: 3, a: 0.123456 })).toBe('rgba(1, 2, 3, 0.123)');
  });
});

describe('toCss', () => {
  it('round-trips a parseable color to a canonical rgb()/rgba() string', () => {
    expect(toCss('#ff0000')).toBe('rgb(255, 0, 0)');
    expect(toCss('rgba(255, 0, 0, 0.5)')).toBe('rgba(255, 0, 0, 0.5)');
  });

  it('returns null when the color cannot be parsed', () => {
    expect(toCss('var(--x)')).toBeNull();
  });
});

describe('toFormat', () => {
  it('returns the input unchanged when unparseable (partial typing is preserved)', () => {
    expect(toFormat('var(--brand', 'hex')).toBe('var(--brand');
  });

  it('uses 8-digit hex only when alpha < 1', () => {
    expect(toFormat('#ff0000', 'hex')).toBe('#ff0000');
    expect(toFormat('rgba(255, 0, 0, 0.5)', 'hex')).toMatch(/^#ff0000[0-9a-f]{2}$/);
  });

  it('dispatches to the requested format family', () => {
    expect(toFormat('#ff0000', 'rgb')).toBe('rgb(255, 0, 0)');
    expect(toFormat('#ff0000', 'hsl')).toMatch(/^hsl\(/);
    expect(toFormat('#ff0000', 'oklch')).toMatch(/^oklch\([\d.]+ [\d.]+ [\d.]+\)$/);
  });

  it('appends rounded alpha in oklch when translucent', () => {
    expect(toFormat('rgba(255, 0, 0, 0.5)', 'oklch')).toContain(' / 0.5)');
  });
});
