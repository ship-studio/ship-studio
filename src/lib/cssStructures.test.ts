import { describe, expect, it } from 'vitest';
import {
  NEST_ITEMS,
  WRAP_ITEMS,
  KEYFRAME_STEP_ITEMS,
  NEW_RULE_ITEMS,
  searchStructures,
  classifyFreeText,
  classifyKeyframeStep,
  isKeyframesSelector,
  keyframesName,
  parseRulePrelude,
} from './cssStructures';

describe('searchStructures', () => {
  it('returns the full group (capped) for an empty query', () => {
    expect(searchStructures(NEST_ITEMS, '').length).toBeGreaterThan(0);
    expect(searchStructures(NEST_ITEMS, '', 3)).toHaveLength(3);
  });

  it('matches on label', () => {
    const r = searchStructures(NEST_ITEMS, 'hover');
    expect(r.some((i) => i.insert === '&:hover')).toBe(true);
  });

  it('matches on hint and keywords, not just the label', () => {
    // "dark" only appears in the hint of the prefers-color-scheme item.
    expect(searchStructures(WRAP_ITEMS, 'dark').some((i) => i.insert.includes('dark'))).toBe(true);
    // "cq" is a keyword on container queries.
    expect(searchStructures(WRAP_ITEMS, 'cq').some((i) => i.insert.startsWith('@container'))).toBe(
      true
    );
    // "contains" is a keyword on :has().
    expect(searchStructures(NEST_ITEMS, 'contains').some((i) => i.insert.startsWith('&:has'))).toBe(
      true
    );
  });

  it('returns nothing for a non-matching query', () => {
    expect(searchStructures(NEST_ITEMS, 'zzzzz')).toHaveLength(0);
  });
});

describe('classifyFreeText', () => {
  it('treats @-rules as a condition (wrap)', () => {
    expect(classifyFreeText('@container (min-width: 600px)')).toEqual({
      label: '@container (min-width: 600px)',
      insert: '@container (min-width: 600px)',
      kind: 'wrap',
    });
  });

  it('keeps an &-relative selector as-is (nest)', () => {
    expect(classifyFreeText('&:focus-within')).toMatchObject({
      insert: '&:focus-within',
      kind: 'nest',
    });
  });

  it('prefixes a bare pseudo with & (covers ::before too)', () => {
    expect(classifyFreeText(':hover')).toMatchObject({ insert: '&:hover', kind: 'nest' });
    expect(classifyFreeText('::after')).toMatchObject({ insert: '&::after', kind: 'nest' });
  });

  it('prefixes a bare descendant/tag/id with "& "', () => {
    expect(classifyFreeText('.icon')).toMatchObject({ insert: '& .icon', kind: 'nest' });
    expect(classifyFreeText('> li')).toMatchObject({ insert: '& > li', kind: 'nest' });
    expect(classifyFreeText('span')).toMatchObject({ insert: '& span', kind: 'nest' });
  });

  it('returns null for empty input', () => {
    expect(classifyFreeText('   ')).toBeNull();
  });
});

describe('isKeyframesSelector', () => {
  it('recognizes @keyframes and vendor-prefixed variants', () => {
    expect(isKeyframesSelector('@keyframes reveal')).toBe(true);
    expect(isKeyframesSelector('  @keyframes  spin ')).toBe(true);
    expect(isKeyframesSelector('@-webkit-keyframes fade')).toBe(true);
  });

  it('rejects ordinary selectors and other at-rules', () => {
    expect(isKeyframesSelector('.card')).toBe(false);
    expect(isKeyframesSelector('@media (min-width: 600px)')).toBe(false);
    expect(isKeyframesSelector('@font-face')).toBe(false);
  });
});

describe('parseRulePrelude (smart selector field)', () => {
  it('treats a plain selector as the selector stage', () => {
    expect(parseRulePrelude('.card')).toEqual({
      condition: null,
      selector: '.card',
      stage: 'selector',
    });
  });

  it('is in the condition stage while composing an @-rule', () => {
    expect(parseRulePrelude('@me')).toMatchObject({ stage: 'condition', condition: null });
    expect(parseRulePrelude('@media (min-width: 1024px)')).toMatchObject({ stage: 'condition' });
  });

  it('switches to the selector stage once a complete condition is followed by space', () => {
    expect(parseRulePrelude('@media (min-width: 1024px) .car')).toEqual({
      condition: '@media (min-width: 1024px)',
      selector: '.car',
      stage: 'selector',
    });
  });

  it('handles keyword conditions and container style queries', () => {
    expect(parseRulePrelude('@media print .x')).toMatchObject({
      condition: '@media print',
      selector: '.x',
    });
    expect(parseRulePrelude('@container style(--a: 1) .card')).toMatchObject({
      condition: '@container style(--a: 1)',
      selector: '.card',
    });
  });

  it('reports an empty selector right after a condition + space', () => {
    expect(parseRulePrelude('@media (max-width: 768px) ')).toEqual({
      condition: '@media (max-width: 768px)',
      selector: '',
      stage: 'selector',
    });
  });

  it('handles chained conditions (and/or)', () => {
    expect(
      parseRulePrelude('@media (min-width: 1024px) and (max-width: 1440px) .card')
    ).toMatchObject({
      condition: '@media (min-width: 1024px) and (max-width: 1440px)',
      selector: '.card',
    });
  });

  it('does not choke on adversarial / partial input', () => {
    for (const t of ['', '   ', '@', '@m', '@media', '@media (', '@media ()', '.a .b > .c']) {
      const r = parseRulePrelude(t);
      // Never throws, always returns a well-formed result.
      expect(r).toHaveProperty('stage');
      expect(typeof r.selector).toBe('string');
      // A bare/partial @-rule stays in the condition stage (no false selector).
      if (t.trimStart().startsWith('@') && !/\)\s+\S/.test(t)) {
        expect(r.stage).toBe('condition');
      }
    }
  });
});

describe('condition (@media) recommendations', () => {
  it('surfaces @media breakpoints from WRAP_ITEMS by keyword', () => {
    const inserts = searchStructures(WRAP_ITEMS, 'media').map((i) => i.insert);
    expect(inserts.some((s) => s.startsWith('@media'))).toBe(true);
  });

  it('offers the full condition catalog (media, container, supports) with an empty query', () => {
    const inserts = searchStructures(WRAP_ITEMS, '').map((i) => i.insert);
    expect(inserts.some((s) => s.startsWith('@media'))).toBe(true);
    expect(inserts.some((s) => s.startsWith('@container'))).toBe(true);
    expect(inserts.some((s) => s.startsWith('@supports'))).toBe(true);
  });
});

describe('keyframesName', () => {
  it('extracts the animation name', () => {
    expect(keyframesName('@keyframes reveal')).toBe('reveal');
    expect(keyframesName('  @keyframes  spin ')).toBe('spin');
    expect(keyframesName('@-webkit-keyframes fade')).toBe('fade');
  });

  it('returns null for non-keyframes selectors', () => {
    expect(keyframesName('.card')).toBeNull();
    expect(keyframesName('@media (min-width: 600px)')).toBeNull();
    expect(keyframesName('@keyframes')).toBeNull();
  });
});

describe('classifyKeyframeStep', () => {
  it('keeps from / to', () => {
    expect(classifyKeyframeStep('from')).toMatchObject({ insert: 'from', kind: 'nest' });
    expect(classifyKeyframeStep('TO')).toMatchObject({ insert: 'to', kind: 'nest' });
  });

  it('appends % to a bare number', () => {
    expect(classifyKeyframeStep('50')).toMatchObject({ insert: '50%' });
    expect(classifyKeyframeStep('50%')).toMatchObject({ insert: '50%' });
  });

  it('normalizes a comma group of stops', () => {
    expect(classifyKeyframeStep('0, 100')).toMatchObject({ insert: '0%, 100%' });
  });

  it('returns null for empty input', () => {
    expect(classifyKeyframeStep('  ')).toBeNull();
  });
});

describe('keyframe + new-rule catalogs', () => {
  it('offers from/to/percentages as steps', () => {
    expect(searchStructures(KEYFRAME_STEP_ITEMS, '').map((i) => i.insert)).toEqual(
      expect.arrayContaining(['from', 'to', '0%', '50%', '100%'])
    );
  });

  it('finds @keyframes from animation keywords in the new-rule list', () => {
    expect(
      searchStructures(NEW_RULE_ITEMS, 'animation').some((i) => i.insert.startsWith('@keyframes'))
    ).toBe(true);
    expect(
      searchStructures(NEW_RULE_ITEMS, 'motion').some((i) => i.insert.startsWith('@keyframes'))
    ).toBe(true);
  });
});
