import { describe, it, expect } from 'vitest';
import { mapLanguageFromFilename } from './discord';

describe('mapLanguageFromFilename', () => {
  it('maps TypeScript files correctly', () => {
    expect(mapLanguageFromFilename('main.ts')).toEqual({ key: 'typescript', name: 'TypeScript' });
    expect(mapLanguageFromFilename('App.tsx')).toEqual({
      key: 'react_ts',
      name: 'TypeScript React',
    });
  });

  it('maps JavaScript files correctly', () => {
    expect(mapLanguageFromFilename('index.js')).toEqual({ key: 'javascript', name: 'JavaScript' });
    expect(mapLanguageFromFilename('Component.jsx')).toEqual({
      key: 'react_js',
      name: 'JavaScript React',
    });
  });

  it('maps Rust files correctly', () => {
    expect(mapLanguageFromFilename('lib.rs')).toEqual({ key: 'rust', name: 'Rust' });
  });

  it('maps Dockerfile correctly', () => {
    expect(mapLanguageFromFilename('Dockerfile')).toEqual({ key: 'docker', name: 'Docker' });
  });

  it('maps git and env config files correctly', () => {
    expect(mapLanguageFromFilename('.gitignore')).toEqual({ key: 'git', name: 'Git' });
    expect(mapLanguageFromFilename('.env')).toEqual({
      key: 'env',
      name: 'Environment Config',
    });
    expect(mapLanguageFromFilename('Cargo.toml')).toEqual({ key: 'toml', name: 'TOML' });
  });

  it('falls back to code for unknown extensions', () => {
    expect(mapLanguageFromFilename('file.unknown')).toEqual({ key: 'code', name: 'Code' });
  });
});
