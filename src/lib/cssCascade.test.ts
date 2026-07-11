import { describe, expect, it } from 'vitest';
import {
  rulesToLocate,
  mergeCascade,
  formatRuleCss,
  rowKey,
  looksLikeCssModuleSelector,
  cssModuleFileHint,
  type MatchedRule,
  type RuleLocation,
} from './cssCascade';

function rule(partial: Partial<MatchedRule>): MatchedRule {
  return {
    selector: '.btn',
    declarations: [{ prop: 'color', value: 'red', important: false, active: true }],
    specificity: [0, 1, 0],
    sourceOrder: 1,
    mediaText: null,
    mediaMinPx: null,
    inactiveMedia: false,
    layer: null,
    href: null,
    origin: 'author',
    ...partial,
  };
}

describe('rulesToLocate', () => {
  it('keeps author rules with a selector and preserves their original index', () => {
    const matched = [
      rule({ selector: '.a' }),
      rule({ origin: 'inline', selector: null }),
      rule({ selector: '.b', mediaText: '(max-width: 768px)', href: 'http://x/s.css' }),
    ];
    const out = rulesToLocate(matched);
    expect(out).toEqual([
      { index: 0, query: { selector: '.a', mediaText: null, href: null, layer: null } },
      {
        index: 2,
        query: {
          selector: '.b',
          mediaText: '(max-width: 768px)',
          href: 'http://x/s.css',
          layer: null,
        },
      },
    ]);
  });

  it('forwards the @layer name so locate can disambiguate same-selector layers', () => {
    const out = rulesToLocate([rule({ selector: '.btn', layer: 'theme' })]);
    expect(out[0].query.layer).toBe('theme');
  });
});

describe('mergeCascade', () => {
  it('marks a resolved author rule editable with its source body', () => {
    const matched = [rule({ selector: '.btn' })];
    const loc: RuleLocation = {
      status: 'resolved',
      file: 'a.css',
      line: 4,
      inner_text: '\n  color: red;\n',
    };
    const [row] = mergeCascade(matched, new Map([[0, loc]]));
    expect(row.editable).toBe(true);
    expect(row.file).toBe('a.css');
    expect(row.line).toBe(4);
    expect(row.innerText).toBe('\n  color: red;\n');
  });

  it('leaves inline, not_found, and multiple rules read-only with a reason', () => {
    const matched = [
      rule({ origin: 'inline', selector: null }),
      rule({ selector: '.ghost' }),
      rule({ selector: '.dup' }),
    ];
    const rows = mergeCascade(
      matched,
      new Map<number, RuleLocation>([
        [1, { status: 'not_found' }],
        [2, { status: 'multiple', files: ['a.css', 'b.css'] }],
      ])
    );
    expect(rows[0].editable).toBe(false);
    expect(rows[0].readonlyReason).toMatch(/inline/);
    expect(rows[1].editable).toBe(false);
    expect(rows[1].readonlyReason).toMatch(/stylesheet/);
    expect(rows[2].editable).toBe(false);
    expect(rows[2].readonlyReason).toMatch(/multiple/);
  });

  it('carries the @container / @supports context onto the row for the chips', () => {
    const matched = [
      rule({ selector: '.card', container: '(min-width: 400px)', supports: '(display: grid)' }),
    ];
    const loc: RuleLocation = {
      status: 'resolved',
      file: 'a.css',
      line: 1,
      inner_text: '\n  color: red;\n',
    };
    const [row] = mergeCascade(matched, new Map([[0, loc]]));
    expect(row.container).toBe('(min-width: 400px)');
    expect(row.supports).toBe('(display: grid)');
  });

  it('treats a missing location entry as read-only (locate failed)', () => {
    const [row] = mergeCascade([rule({ selector: '.x' })], new Map());
    expect(row.editable).toBe(false);
  });

  it('explains CSS-Module rules when the project hints at hashed class names', () => {
    const matched = [rule({ selector: '.Hero_title__x7f2a' })];
    const [row] = mergeCascade(matched, new Map([[0, { status: 'not_found' } as RuleLocation]]), {
      cssModulesHint: true,
    });
    expect(row.editable).toBe(false);
    expect(row.readonlyReason).toMatch(/CSS Module/);
    expect(row.readonlyReason).toContain('Hero.module.css');
  });

  it('keeps the generic not-found reason without the hint, or for non-module selectors', () => {
    const moduleRule = [rule({ selector: '.Hero_title__x7f2a' })];
    const notFound = new Map<number, RuleLocation>([[0, { status: 'not_found' }]]);
    // Same selector, but the project is not Next.js → generic wording.
    expect(mergeCascade(moduleRule, notFound)[0].readonlyReason).toMatch(/stylesheet/);
    // Next.js project, but an ordinary class → generic wording.
    const plain = [rule({ selector: '.hero-title' })];
    expect(mergeCascade(plain, notFound, { cssModulesHint: true })[0].readonlyReason).toMatch(
      /stylesheet/
    );
  });
});

describe('looksLikeCssModuleSelector', () => {
  it('recognizes webpack [name]_[local]__[hash] classes and __hash suffixes', () => {
    expect(looksLikeCssModuleSelector('.Hero_title__x7f2a')).toBe(true);
    expect(looksLikeCssModuleSelector('.card__aB3_x9')).toBe(true);
    expect(looksLikeCssModuleSelector('main .Hero_title__x7f2a > span')).toBe(true);
  });

  it('rejects ordinary classes, BEM-ish short suffixes, and tag selectors', () => {
    expect(looksLikeCssModuleSelector('.hero-title')).toBe(false);
    expect(looksLikeCssModuleSelector('.btn__sm')).toBe(false); // BEM element, too short
    expect(looksLikeCssModuleSelector('h1')).toBe(false);
    expect(looksLikeCssModuleSelector('.snake_case_name')).toBe(false);
  });

  it('rejects BEM classes from third-party package CSS — the suffix must look like a hash', () => {
    // Real-world BEM with long, all-lowercase "elements": these live in
    // package stylesheets (not_found in a Next.js project) and must NOT get
    // the "edit the .module.css" explanation. A hash has a digit/uppercase.
    expect(looksLikeCssModuleSelector('.react-datepicker__header')).toBe(false);
    expect(looksLikeCssModuleSelector('.card__title')).toBe(false);
    expect(looksLikeCssModuleSelector('.swiper__wrapper .swiper__slide')).toBe(false);
    // Still recognizes genuine hashes alongside BEM-ish nesting.
    expect(looksLikeCssModuleSelector('.card__title .Hero_title__x7f2a')).toBe(true);
  });
});

describe('cssModuleFileHint', () => {
  it('derives <Name>.module.css from a full-shape hashed class', () => {
    expect(cssModuleFileHint('.Hero_title__x7f2a')).toBe('Hero.module.css');
    expect(cssModuleFileHint('main .Nav_link__Ab12Cd')).toBe('Nav.module.css');
  });

  it('returns null when the shape does not pin a module name (no guessing)', () => {
    expect(cssModuleFileHint('.card__aB3_x9')).toBeNull();
    expect(cssModuleFileHint('.hero-title')).toBeNull();
  });
});

describe('formatRuleCss', () => {
  it('emits a bare rule (media context comes from the group it is replaced into)', () => {
    expect(formatRuleCss('.btn', ' color: red; ')).toBe('.btn { color: red; }');
    expect(formatRuleCss('.btn', '\n  &:hover { color: blue; }\n')).toBe(
      '.btn {\n  &:hover { color: blue; }\n}'
    );
  });
});

describe('rowKey', () => {
  it('is stable for a row and distinguishes rows that differ only by index', () => {
    const a = mergeCascade(
      [rule({ selector: '.btn' })],
      new Map([[0, { status: 'resolved', file: 'a.css', line: 1, inner_text: '' }]])
    )[0];
    expect(rowKey(a)).toBe(rowKey({ ...a }));
    expect(rowKey(a)).not.toBe(rowKey({ ...a, index: 1 }));
  });
});
