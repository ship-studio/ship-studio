import { describe, expect, it } from 'vitest';
import type { CssConsolidationCandidate } from './cssCascade';
import { relevantCssConsolidationCandidates } from './cssConsolidationPresentation';

function candidate(options: Partial<CssConsolidationCandidate> = {}): CssConsolidationCandidate {
  const first = {
    sourcePath: 'src/styles/site.css',
    sourceVersion: 'version-1',
    selectorOffset: 10,
    selector: '.card, .card--active',
    selectorMemberIndex: 0,
    matchedSelector: '.card',
    selectorMembers: ['.card', '.card--active'],
    innerText: 'color: red;',
    contextPath: [],
  };
  const second = {
    ...first,
    selectorOffset: 48,
    innerText: 'background: white;',
  };

  return {
    file: 'src/styles/site.css',
    before: '.card, .card--active { color: red; }\n.card, .card--active { background: white; }',
    after: '.card, .card--active { color: red; background: white; }',
    sourceVersion: 'version-1',
    first,
    second,
    ...options,
  };
}

describe('relevantCssConsolidationCandidates', () => {
  it('keeps only backend plans that touch an exact current source occurrence', () => {
    const relevant = candidate();
    const unrelatedSelector = candidate({
      first: { ...relevant.first, selectorOffset: 90 },
      second: { ...relevant.second, selectorOffset: 120 },
    });
    const staleSnapshot = candidate({
      sourceVersion: 'version-0',
      first: { ...relevant.first, sourceVersion: 'version-0' },
      second: { ...relevant.second, sourceVersion: 'version-0' },
    });

    expect(
      relevantCssConsolidationCandidates(
        [relevant, unrelatedSelector, staleSnapshot],
        [{ file: 'src/styles/site.css', sourceVersion: 'version-1', selectorOffset: 48 }]
      )
    ).toEqual([relevant]);
  });

  it('honors the current search across the path and review text', () => {
    const safe = candidate();
    const source = [{ file: safe.file, sourceVersion: safe.sourceVersion, selectorOffset: 10 }];

    expect(relevantCssConsolidationCandidates([safe], source, 'site.css')).toEqual([safe]);
    expect(relevantCssConsolidationCandidates([safe], source, 'background')).toEqual([safe]);
    expect(relevantCssConsolidationCandidates([safe], source, 'unrelated')).toEqual([]);
  });

  it('rejects candidates whose identity paths do not agree with the returned file', () => {
    const safe = candidate({ first: { ...candidate().first, sourcePath: 'src/other.css' } });

    expect(
      relevantCssConsolidationCandidates(
        [safe],
        [{ file: 'src/styles/site.css', sourceVersion: safe.sourceVersion, selectorOffset: 10 }]
      )
    ).toEqual([]);
  });
});
