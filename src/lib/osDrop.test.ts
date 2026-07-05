import { afterEach, describe, expect, it, vi } from 'vitest';
import { cssCandidatesForDrop } from './osDrop';

/**
 * Stub `navigator.userAgent` and `window.devicePixelRatio` for one assertion.
 * wry reports the drop position in logical points on macOS but physical pixels
 * on Windows, so the candidate ordering must adapt per platform + DPI.
 */
function withEnv(userAgent: string, dpr: number, fn: () => void) {
  const uaSpy = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  const original = window.devicePixelRatio;
  Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true });
  try {
    fn();
  } finally {
    uaSpy.mockRestore();
    Object.defineProperty(window, 'devicePixelRatio', { value: original, configurable: true });
  }
}

const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)';

describe('cssCandidatesForDrop', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns a single candidate when devicePixelRatio is 1 (both spaces coincide)', () => {
    withEnv(MAC_UA, 1, () => {
      expect(cssCandidatesForDrop({ x: 300, y: 200 })).toEqual([{ x: 300, y: 200 }]);
    });
    withEnv(WIN_UA, 1, () => {
      expect(cssCandidatesForDrop({ x: 300, y: 200 })).toEqual([{ x: 300, y: 200 }]);
    });
  });

  it('on macOS Retina, tries the position as-is FIRST (it is already CSS px)', () => {
    withEnv(MAC_UA, 2, () => {
      // The bug was halving this already-correct coordinate. Logical must win.
      expect(cssCandidatesForDrop({ x: 300, y: 200 })).toEqual([
        { x: 300, y: 200 },
        { x: 150, y: 100 },
      ]);
    });
  });

  it('on Windows at >100% scaling, divides by DPI FIRST (position is physical px)', () => {
    withEnv(WIN_UA, 2, () => {
      expect(cssCandidatesForDrop({ x: 300, y: 200 })).toEqual([
        { x: 150, y: 100 },
        { x: 300, y: 200 },
      ]);
    });
  });

  it('handles fractional Windows DPI (150%)', () => {
    withEnv(WIN_UA, 1.5, () => {
      expect(cssCandidatesForDrop({ x: 300, y: 150 })).toEqual([
        { x: 200, y: 100 },
        { x: 300, y: 150 },
      ]);
    });
  });
});
