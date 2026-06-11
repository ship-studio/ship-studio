import { describe, expect, it } from 'vitest';
import { assetWebPath, isImageFile } from './assets';

describe('assetWebPath', () => {
  it('maps an asset path to its root-relative URL', () => {
    expect(assetWebPath('hero.png')).toBe('/hero.png');
    expect(assetWebPath('images/hero.png')).toBe('/images/hero.png');
  });

  it('percent-encodes segments but keeps the slashes', () => {
    expect(assetWebPath('images/My Logo (1).png')).toBe('/images/My%20Logo%20(1).png');
    expect(assetWebPath('a#b/c d.png')).toBe('/a%23b/c%20d.png');
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
