import { describe, expect, it } from 'vitest';
import { isDevIconGalleryRequested } from './DevIconGallery';

describe('development icon gallery gate', () => {
  it('requires the explicit gallery query parameter', () => {
    expect(isDevIconGalleryRequested('?iconGallery=1')).toBe(true);
    expect(isDevIconGalleryRequested('?iconGallery=0')).toBe(false);
    expect(isDevIconGalleryRequested('')).toBe(false);
  });
});
