import { describe, it, expect } from 'vitest';
import { basename, pathSegments } from './paths';

describe('basename', () => {
  it('extracts the final segment of POSIX paths (macOS)', () => {
    expect(basename('/Users/me/ShipStudio/my-app')).toBe('my-app');
    expect(basename('src/components/App.tsx')).toBe('App.tsx');
    expect(basename('single')).toBe('single');
  });

  it('extracts the final segment of Windows paths', () => {
    expect(basename('C:\\Users\\me\\ShipStudio\\my-app')).toBe('my-app');
    expect(basename('src\\components\\App.tsx')).toBe('App.tsx');
    expect(basename('C:\\my-app')).toBe('my-app');
  });

  it('handles mixed separators (Windows paths with forward slashes)', () => {
    expect(basename('C:/Users/me/my-app')).toBe('my-app');
    expect(basename('C:\\Users\\me/nested/app')).toBe('app');
  });

  it('ignores trailing separators', () => {
    expect(basename('/Users/me/app/')).toBe('app');
    expect(basename('C:\\Users\\me\\app\\')).toBe('app');
  });

  it('falls back to the original string when there is no usable segment', () => {
    expect(basename('')).toBe('');
    expect(basename('/')).toBe('/');
  });
});

describe('pathSegments', () => {
  it('splits POSIX paths and drops empty segments', () => {
    expect(pathSegments('/a/b/c')).toEqual(['a', 'b', 'c']);
    expect(pathSegments('a//b')).toEqual(['a', 'b']);
  });

  it('splits Windows paths', () => {
    expect(pathSegments('C:\\a\\b\\c')).toEqual(['C:', 'a', 'b', 'c']);
  });
});
