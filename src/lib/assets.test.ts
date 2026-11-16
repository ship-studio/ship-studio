import { describe, expect, it } from 'vitest';
import { assetWebPath, isImageFile } from './assets';

describe('assetWebPath', () => {
  it('maps an asset path to its root-relative URL', () => {
    expect(assetWebPath('public', 'hero.png')).toBe('/hero.png');
    expect(assetWebPath('public', 'images/hero.png')).toBe('/images/hero.png');
  });

  it('percent-encodes segments but keeps the slashes', () => {
    expect(assetWebPath('public', 'images/My Logo (1).png')).toBe(
      '/images/My%20Logo%20%281%29.png'
    );
    expect(assetWebPath('public', "a#b/c d's.png")).toBe('/a%23b/c%20d%27s.png');
  });

  it('rejects asset roots without a known public URL mapping', () => {
    expect(() => assetWebPath('src/assets', 'hero.png')).toThrow('safe public URL mapping');
  });
});

describe('isImageFile', () => {
  it('recognizes image extensions case-insensitively', () => {
    expect(isImageFile('photo.JPG')).toBe(true);
    expect(isImageFile('icon.svg')).toBe(true);
    expect(isImageFile('notes.txt')).toBe(false);
    expect(isImageFile('archive.png.zip')).toBe(false);
  });
});
