import { describe, it, expect, vi, beforeEach } from 'vitest';

// Control the platform per-test by mocking isMac(); the real platform() caches
// navigator.userAgent at module load, which we can't flip mid-suite.
vi.mock('./setup', () => ({ isMac: vi.fn() }));

import { isMac } from './setup';
import { kbd, modKey } from './shortcuts';

const mockedIsMac = vi.mocked(isMac);

describe('kbd', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('on macOS (glyphs, tightly joined — must equal the old hardcoded labels)', () => {
    beforeEach(() => mockedIsMac.mockReturnValue(true));

    it('renders single-modifier shortcuts with glyphs', () => {
      expect(kbd('mod', 'K')).toBe('⌘K');
      expect(kbd('mod', 'Z')).toBe('⌘Z');
      expect(kbd('mod', 'T')).toBe('⌘T');
      expect(kbd('mod', '/')).toBe('⌘/');
      expect(kbd('mod', '1')).toBe('⌘1');
    });

    it('renders multi-modifier shortcuts packed with no separator', () => {
      expect(kbd('mod', 'shift', 'S')).toBe('⌘⇧S');
      expect(kbd('mod', 'shift', 'C')).toBe('⌘⇧C');
      expect(kbd('mod', 'shift', 'Z')).toBe('⌘⇧Z');
    });

    it('maps every modifier token to its glyph', () => {
      expect(kbd('alt', 'X')).toBe('⌥X');
      expect(kbd('ctrl', 'X')).toBe('⌃X');
    });

    it('modKey is the command glyph', () => {
      expect(modKey()).toBe('⌘');
    });
  });

  describe('on Windows (words, joined with +)', () => {
    beforeEach(() => mockedIsMac.mockReturnValue(false));

    it('renders single-modifier shortcuts with Ctrl', () => {
      expect(kbd('mod', 'K')).toBe('Ctrl+K');
      expect(kbd('mod', 'Z')).toBe('Ctrl+Z');
      expect(kbd('mod', 'T')).toBe('Ctrl+T');
      expect(kbd('mod', '/')).toBe('Ctrl+/');
      expect(kbd('mod', '1')).toBe('Ctrl+1');
    });

    it('renders multi-modifier shortcuts spelled out and +-joined', () => {
      expect(kbd('mod', 'shift', 'S')).toBe('Ctrl+Shift+S');
      expect(kbd('mod', 'shift', 'C')).toBe('Ctrl+Shift+C');
      expect(kbd('mod', 'shift', 'Z')).toBe('Ctrl+Shift+Z');
    });

    it('maps Option→Alt and the literal Control key', () => {
      expect(kbd('alt', 'X')).toBe('Alt+X');
      expect(kbd('ctrl', 'X')).toBe('Ctrl+X');
    });

    it('modKey is the word Ctrl', () => {
      expect(modKey()).toBe('Ctrl');
    });
  });
});
