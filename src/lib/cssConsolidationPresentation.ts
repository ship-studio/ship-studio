import type { CssConsolidationCandidate } from './cssCascade';

/** One exact source occurrence visible in the current CSS selection. */
export interface CssConsolidationSourceRef {
  file: string;
  sourceVersion: string;
  selectorOffset: number;
}

/** Stable key for the plan returned for one pair of adjacent source rules. */
export function cssConsolidationCandidateKey(candidate: CssConsolidationCandidate): string {
  return `${candidate.file}:${candidate.first.selectorOffset}:${candidate.second.selectorOffset}:${candidate.sourceVersion}`;
}

/**
 * Keep backend plans that touch a source rule in the current selection. The backend
 * remains the authority for whether a merge is safe; this only narrows those plans
 * to exact source occurrences the editor already resolved for the selected element.
 */
export function relevantCssConsolidationCandidates(
  candidates: readonly CssConsolidationCandidate[],
  sources: readonly CssConsolidationSourceRef[],
  searchTerm = ''
): CssConsolidationCandidate[] {
  if (candidates.length === 0 || sources.length === 0) return [];

  const query = searchTerm.trim().toLocaleLowerCase();
  return candidates.filter((candidate) => {
    if (
      candidate.first.sourcePath !== candidate.file ||
      candidate.second.sourcePath !== candidate.file ||
      candidate.first.sourceVersion !== candidate.sourceVersion ||
      candidate.second.sourceVersion !== candidate.sourceVersion
    ) {
      return false;
    }

    const touchesVisibleRule = sources.some(
      (source) =>
        source.file === candidate.file &&
        source.sourceVersion === candidate.sourceVersion &&
        (source.selectorOffset === candidate.first.selectorOffset ||
          source.selectorOffset === candidate.second.selectorOffset)
    );
    if (!touchesVisibleRule) return false;
    if (!query) return true;

    return [candidate.file, candidate.first.selector, candidate.before, candidate.after].some(
      (value) => value.toLocaleLowerCase().includes(query)
    );
  });
}
