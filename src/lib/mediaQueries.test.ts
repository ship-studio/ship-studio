import { describe, expect, it } from 'vitest';
import {
  normalizeMediaQueryChunk,
  parseMediaQuery,
  serializeMediaQuery,
  suggestMediaQueryChunks,
} from './mediaQueries';

describe('media query chunks', () => {
  it('splits a media condition into editable semantic pieces', () => {
    expect(parseMediaQuery('screen and (max-width: 767px)')).toEqual([
      { kind: 'type', value: 'screen' },
      { kind: 'operator', value: 'and' },
      { kind: 'feature', value: 'max-width:' },
      { kind: 'value', value: '767px', feature: 'max-width' },
    ]);
  });

  it('round-trips feature values and comma-separated queries', () => {
    expect(serializeMediaQuery(parseMediaQuery('screen and (max-width: 767px)'))).toBe(
      'screen and (max-width: 767px)'
    );
    expect(serializeMediaQuery(parseMediaQuery('screen, print'))).toBe('screen, print');
  });

  it('suggests values from the active chunk vocabulary', () => {
    expect(suggestMediaQueryChunks('type', 'sc')).toContain('screen');
    expect(suggestMediaQueryChunks('feature', 'max')).toContain('max-width:');
    expect(suggestMediaQueryChunks('value', 'd', 'prefers-color-scheme:')).toEqual(['dark']);
  });

  it('normalizes authored chunk values without changing free-form values', () => {
    expect(normalizeMediaQueryChunk('operator', 'AND')).toBe('and');
    expect(normalizeMediaQueryChunk('feature', 'max-width')).toBe('max-width:');
    expect(normalizeMediaQueryChunk('value', '767PX')).toBe('767PX');
  });
});
