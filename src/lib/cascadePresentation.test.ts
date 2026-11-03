import { describe, expect, it } from 'vitest';
import {
  applyCascadeActivity,
  positionCascadeDrafts,
  rowKey,
  groupCascadeRows,
  type CascadeRow,
  type MatchedRule,
} from './cssCascade';
import {
  groupCascadeItemsByFile,
  isCascadeFileGroup,
  orderCascadeRowsForDisplay,
} from './cascadePresentation';

function row(
  selector: string,
  index: number,
  sourceOrder?: number,
  line?: number,
  draft = false,
  specificity: [number, number, number] = [0, 0, 0]
): CascadeRow {
  return {
    index,
    selector,
    declarations: [],
    specificity,
    sourceOrder,
    mediaText: null,
    mediaMinPx: null,
    inactiveMedia: false,
    layer: null,
    origin: 'author',
    editable: true,
    line,
    draft,
  };
}

function matchedRule(
  selector: string,
  sourceOrder: number,
  overrides: Partial<MatchedRule> = {}
): MatchedRule {
  return {
    selector,
    declarations: [{ prop: 'color', value: 'red', important: false, active: true }],
    specificity: [0, 1, 0],
    sourceOrder,
    mediaText: null,
    mediaMinPx: null,
    inactiveMedia: false,
    layer: null,
    href: null,
    origin: 'author',
    ...overrides,
  };
}

describe('cascade presentation order', () => {
  it('groups drafts by verified destination while preserving noncontiguous source runs', () => {
    const sourceA = 'src/pages/index.astro?style=0';
    const sourceB = 'src/styles/site.css';
    const authored = (selector: string, index: number, file: string): CascadeRow => ({
      ...row(selector, index, index + 1, index + 2),
      editable: true,
      file,
    });
    const draft = (selector: string, index: number, file?: string): CascadeRow => ({
      ...row(selector, index, undefined, undefined, true),
      file: undefined,
      line: undefined,
      innerText: undefined,
      draftTargetFile: file,
    });

    const sameFileRows = [
      authored('*', 0, sourceA),
      draft('div', 1, sourceA),
      authored('.intro-copy', 2, sourceA),
    ];
    const sameFileGroups = groupCascadeItemsByFile(groupCascadeRows(sameFileRows));
    expect(sameFileGroups).toHaveLength(1);
    expect(sameFileGroups[0]).toMatchObject({
      kind: 'source',
      source: { kind: 'resolved', file: sourceA },
    });

    const noncontiguousRows = [
      authored('.first', 3, sourceA),
      draft('span', 4, sourceB),
      authored('.middle', 5, sourceB),
      authored('.last', 6, sourceA),
    ];
    const noncontiguousGroups = groupCascadeItemsByFile(groupCascadeRows(noncontiguousRows));
    const groupFiles = noncontiguousGroups
      .filter(isCascadeFileGroup)
      .map((group) =>
        group.kind === 'source'
          ? group.source.kind === 'resolved'
            ? group.source.file
            : group.source.files.join(',')
          : group.file
      );
    const displaySelectors = noncontiguousGroups.flatMap((group) => {
      const items = isCascadeFileGroup(group) ? group.items : [group];
      return items.flatMap((item) =>
        item.kind === 'media' ? item.rows.map((itemRow) => itemRow.selector) : [item.row.selector]
      );
    });

    expect(groupFiles).toEqual([sourceA, sourceB, sourceA]);
    expect(displaySelectors).toEqual(['.first', 'span', '.middle', '.last']);
  });

  it('places newest locally-created selectors at either display edge without mutating rows', () => {
    const oldestCreated = row('.created-first', 1_000_001, undefined, 0);
    const newestCreated = row('.created-last', 1_000_002, undefined, 0);
    const existing = row('.existing', 0, 4, 12);
    const draft = row('.draft', 1, undefined, 0, true);
    const original = [existing, oldestCreated, draft, newestCreated];

    expect(orderCascadeRowsForDisplay(original, 'newest-top')).toEqual([
      newestCreated,
      oldestCreated,
      existing,
      draft,
    ]);
    expect(orderCascadeRowsForDisplay(original, 'newest-bottom')).toEqual([
      draft,
      existing,
      oldestCreated,
      newestCreated,
    ]);
    expect(original).toEqual([existing, oldestCreated, draft, newestCreated]);
  });

  it('keeps inactive rows after applying rows in either display direction', () => {
    const firstActive = row('.first-active', 1, 10, 11);
    const activeMedia = {
      ...row('.active-media', 2, 20, 12),
      mediaText: '(min-width: 700px)',
    };
    const draft = row('.draft', 3, undefined, 0, true);
    const lastActive = row('.last-active', 4, 30, 13);
    const firstInactive = { ...row('.inactive-first', 5, 40, 14), inactiveMedia: true };
    const lastInactive = { ...row('.inactive-last', 6, 50, 15), inactiveMedia: true };
    const original = [firstActive, activeMedia, draft, lastActive, firstInactive, lastInactive];

    expect(orderCascadeRowsForDisplay(original, 'newest-top')).toEqual([
      firstActive,
      activeMedia,
      draft,
      lastActive,
      firstInactive,
      lastInactive,
    ]);
    expect(orderCascadeRowsForDisplay(original, 'newest-bottom')).toEqual([
      lastActive,
      draft,
      activeMedia,
      firstActive,
      lastInactive,
      firstInactive,
    ]);
  });

  it('refreshes matched row order from activity while preserving synthetic rows and keys', () => {
    const created = row('.created', 1_000_001, undefined, 0);
    const base = row('.base', 1, 10, 11);
    const responsive = {
      ...row('.responsive', 2, 20, 12),
      mediaText: '(min-width: 700px)',
      inactiveMedia: true,
    };
    const draft = row('.draft', 1_000_002, undefined, 0, true);
    const reducedMotion = {
      ...row('.reduced-motion', 3, 30, 13),
      mediaText: '(prefers-reduced-motion: reduce)',
      inactiveMedia: true,
    };
    const original = [created, base, responsive, draft, reducedMotion];
    const refreshed = applyCascadeActivity(original, [
      matchedRule('.responsive', 20, {
        mediaText: '(min-width: 700px)',
        declarations: [{ prop: 'color', value: 'blue', important: false, active: true }],
      }),
      matchedRule('.base', 10),
      matchedRule('.reduced-motion', 30, {
        mediaText: '(prefers-reduced-motion: reduce)',
        inactiveMedia: true,
      }),
    ]);

    expect(refreshed.map((item) => item.selector)).toEqual([
      '.created',
      '.responsive',
      '.base',
      '.draft',
      '.reduced-motion',
    ]);
    expect(refreshed[0]).toBe(created);
    expect(refreshed[3]).toBe(draft);
    expect(rowKey(refreshed[1])).toBe(rowKey(responsive));
    expect(refreshed[1]).toMatchObject({ inactiveMedia: false, declarations: [{ value: 'blue' }] });
    expect(refreshed[4].inactiveMedia).toBe(true);
  });

  it('repositions multiple drafts across wide, narrow, and wide activity updates', () => {
    const baseClass = row('.card', 1, 30, 8, false, [0, 1, 0]);
    const responsiveClass = {
      ...row('.card', 2, 20, 12, false, [0, 1, 0]),
      mediaText: '(min-width: 700px)',
    };
    const universal = row('*', 3, 10, 16, false, [0, 0, 0]);
    const classDraft = row('.featured', 4, undefined, 0, true, [0, 1, 0]);
    const tagDraft = row('div', 5, undefined, 0, true, [0, 0, 1]);
    const wideRules = [
      matchedRule('.card', 30, { specificity: [0, 1, 0] }),
      matchedRule('.card', 20, {
        specificity: [0, 1, 0],
        mediaText: '(min-width: 700px)',
      }),
      matchedRule('*', 10, { specificity: [0, 0, 0] }),
    ];
    const narrowRules = [
      wideRules[0],
      wideRules[2],
      matchedRule('.card', 20, {
        specificity: [0, 1, 0],
        mediaText: '(min-width: 700px)',
        inactiveMedia: true,
      }),
    ];
    const initialWide = positionCascadeDrafts([
      baseClass,
      responsiveClass,
      universal,
      classDraft,
      tagDraft,
    ]);
    const wide = applyCascadeActivity(initialWide, wideRules);

    const expectPresentation = (rows: CascadeRow[], state: 'wide' | 'narrow') => {
      const label = (row: CascadeRow) =>
        row.draft
          ? `${row.selector} draft`
          : row.mediaText
            ? `${row.selector} media`
            : row.selector;
      const highToLow = orderCascadeRowsForDisplay(rows, 'newest-top').map(label);
      const lowToHigh = orderCascadeRowsForDisplay(rows, 'newest-bottom').map(label);

      expect(highToLow).toEqual(
        state === 'wide'
          ? ['.card', '.card media', '.featured draft', 'div draft', '*']
          : ['.card', '.featured draft', 'div draft', '*', '.card media']
      );
      expect(lowToHigh).toEqual(
        state === 'wide'
          ? ['*', 'div draft', '.featured draft', '.card media', '.card']
          : ['*', 'div draft', '.featured draft', '.card', '.card media']
      );
      expect(rows.find((row) => row.draft && row.selector === 'div')?.declarations).toEqual([]);
      expect(rows.find((row) => row.draft && row.selector === '.featured')?.declarations).toEqual(
        []
      );
      expect(rows.find((row) => row.selector === '.card' && row.mediaText)?.inactiveMedia).toBe(
        state === 'narrow'
      );
      expect(rowKey(rows.find((row) => row.selector === '.card' && row.mediaText)!)).toBe(
        rowKey(responsiveClass)
      );
      expect(rows.find((row) => row.draft && row.selector === '.featured')).toBe(classDraft);
      expect(rows.find((row) => row.draft && row.selector === 'div')).toBe(tagDraft);
    };

    expectPresentation(wide, 'wide');
    const narrow = applyCascadeActivity(wide, narrowRules);
    expectPresentation(narrow, 'narrow');
    const wideAgain = applyCascadeActivity(narrow, wideRules);
    expectPresentation(wideAgain, 'wide');
  });
});
