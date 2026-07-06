import { describe, it, expect } from 'vitest';
import { physicalToLogical, isPointInRect } from './dropTarget';

describe('physicalToLogical', () => {
  it('divides physical coordinates by the device pixel ratio', () => {
    expect(physicalToLogical({ x: 200, y: 100 }, 2)).toEqual({ x: 100, y: 50 });
    expect(physicalToLogical({ x: 150, y: 300 }, 1.5)).toEqual({ x: 100, y: 200 });
  });

  it('is the identity at ratio 1', () => {
    expect(physicalToLogical({ x: 42, y: 7 }, 1)).toEqual({ x: 42, y: 7 });
  });

  it('treats non-positive or non-finite ratios as 1', () => {
    expect(physicalToLogical({ x: 10, y: 20 }, 0)).toEqual({ x: 10, y: 20 });
    expect(physicalToLogical({ x: 10, y: 20 }, -2)).toEqual({ x: 10, y: 20 });
    expect(physicalToLogical({ x: 10, y: 20 }, NaN)).toEqual({ x: 10, y: 20 });
    expect(physicalToLogical({ x: 10, y: 20 }, Infinity)).toEqual({ x: 10, y: 20 });
  });
});

describe('isPointInRect', () => {
  const rect = { left: 100, top: 50, right: 300, bottom: 250 };

  it('accepts a point inside the rect', () => {
    expect(isPointInRect({ x: 200, y: 150 }, rect)).toBe(true);
  });

  it('accepts the top-left edge and rejects the bottom-right edge (half-open)', () => {
    expect(isPointInRect({ x: 100, y: 50 }, rect)).toBe(true);
    expect(isPointInRect({ x: 300, y: 250 }, rect)).toBe(false);
    expect(isPointInRect({ x: 299.9, y: 249.9 }, rect)).toBe(true);
  });

  it('rejects points outside on each side', () => {
    expect(isPointInRect({ x: 99, y: 150 }, rect)).toBe(false); // left
    expect(isPointInRect({ x: 301, y: 150 }, rect)).toBe(false); // right
    expect(isPointInRect({ x: 200, y: 49 }, rect)).toBe(false); // above
    expect(isPointInRect({ x: 200, y: 251 }, rect)).toBe(false); // below
  });

  it('never matches zero- or negative-area rects (hidden elements)', () => {
    expect(isPointInRect({ x: 0, y: 0 }, { left: 0, top: 0, right: 0, bottom: 0 })).toBe(false);
    expect(isPointInRect({ x: 10, y: 10 }, { left: 10, top: 0, right: 10, bottom: 20 })).toBe(
      false
    );
    expect(isPointInRect({ x: 5, y: 5 }, { left: 10, top: 10, right: 0, bottom: 0 })).toBe(false);
  });

  it('routes a drop to the correct pane of a side-by-side split', () => {
    const leftPane = { left: 0, top: 40, right: 400, bottom: 600 };
    const rightPane = { left: 400, top: 40, right: 800, bottom: 600 };
    const dropInRight = physicalToLogical({ x: 1200, y: 400 }, 2); // -> (600, 200)
    expect(isPointInRect(dropInRight, leftPane)).toBe(false);
    expect(isPointInRect(dropInRight, rightPane)).toBe(true);
  });
});
