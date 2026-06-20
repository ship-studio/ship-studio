import { describe, it, expect } from 'vitest';
import { isMobileProjectType } from './static-server';

describe('isMobileProjectType', () => {
  it('is true for native mobile project types', () => {
    expect(isMobileProjectType('reactnative')).toBe(true);
    expect(isMobileProjectType('flutter')).toBe(true);
  });

  it('is false for web and unknown project types', () => {
    expect(isMobileProjectType('vite')).toBe(false);
    expect(isMobileProjectType('nextjs')).toBe(false);
    expect(isMobileProjectType('statichtml')).toBe(false);
    expect(isMobileProjectType('unknown')).toBe(false);
  });
});
