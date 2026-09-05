import { describe, expect, it } from 'vitest';
import { afterEach, vi } from 'vitest';
import {
  scaleValue,
  steppedScale,
  SPACING_CONTROLS,
  ENUM_CONTROLS,
  activeEnumToken,
  boxSideValue,
  boxSideToken,
  boxInlineStyle,
  arbitraryColor,
  colorToken,
  arbitraryColorRaw,
  colorClassToken,
  colorFormatOf,
  tokensForVariant,
  withVariant,
  resolveCascade,
  breakpointPrefixes,
  BASE_BREAKPOINT,
  DEFAULT_BREAKPOINTS,
  arbitraryValue,
  spacingValue,
  boxSide,
  boxSideResetSpec,
  positionSide,
  positionSideResetSpec,
  positionSidePrefix,
  spacingCss,
  spacingDisplay,
  spacingTokenFor,
  utilityTokenFor,
  arbitraryToken,
  parseSpacingInput,
  stepSpacingValue,
  removeAtLayer,
  competesWithUnlayered,
  markImportant,
  radiusResetSpec,
  type Breakpoint,
} from './edit';

const ORDERED: Breakpoint[] = [BASE_BREAKPOINT, ...DEFAULT_BREAKPOINTS];
const KNOWN = breakpointPrefixes(DEFAULT_BREAKPOINTS);
const BP = (name: string) => ORDERED.find((b) => b.name === name)!;

describe('tokensForVariant', () => {
  it('scopes the base layer, keeping hover/focus but dropping breakpoint tokens', () => {
    expect(tokensForVariant('p-4 md:p-8 hover:p-2 lg:flex', null, KNOWN)).toBe('p-4 hover:p-2');
  });
  it('scopes a breakpoint layer, stripping exactly that one prefix', () => {
    expect(tokensForVariant('p-4 md:p-8 md:hover:p-2 lg:p-12', 'md', KNOWN)).toBe('p-8 hover:p-2');
  });
  it('never mis-parses a colon-bearing arbitrary value (stays in base)', () => {
    // The colon is inside the bracket; its lead isn't a known breakpoint.
    expect(tokensForVariant('bg-[url(http://x.com/a.png)]', null, KNOWN)).toBe(
      'bg-[url(http://x.com/a.png)]'
    );
    expect(tokensForVariant('bg-[url(http://x.com/a.png)]', 'md', KNOWN)).toBe('');
  });
  it('reads a scale value out of a breakpoint layer via the existing reader', () => {
    expect(scaleValue(tokensForVariant('p-4 md:p-8', 'md', KNOWN), 'p')).toBe(8);
    expect(scaleValue(tokensForVariant('p-4 md:p-8', null, KNOWN), 'p')).toBe(4);
  });
});

describe('withVariant', () => {
  it('prefixes for a breakpoint and is identity for base', () => {
    expect(withVariant('md', 'p-6')).toBe('md:p-6');
    expect(withVariant(null, 'p-6')).toBe('p-6');
    // Round-trips arbitrary color tokens (escaping already applied upstream).
    expect(withVariant('md', 'text-[oklch(0.62_0.18_39)]')).toBe('md:text-[oklch(0.62_0.18_39)]');
  });
});

describe('resolveCascade', () => {
  const readP = (scoped: string) => scaleValue(scoped, 'p');

  it('returns the value set on the active breakpoint (set here)', () => {
    const r = resolveCascade('p-4 md:p-8', BP('md'), ORDERED, readP, KNOWN);
    expect(r.value).toBe(8);
    expect(r.definedAt?.name).toBe('md');
  });
  it('inherits from a smaller breakpoint when the active one is unset', () => {
    // At lg there is no lg:p-*; the cascade falls to md:p-8.
    const r = resolveCascade('p-4 md:p-8', BP('lg'), ORDERED, readP, KNOWN);
    expect(r.value).toBe(8);
    expect(r.definedAt?.name).toBe('md');
  });
  it('falls all the way to base', () => {
    const r = resolveCascade('p-4', BP('xl'), ORDERED, readP, KNOWN);
    expect(r.value).toBe(4);
    expect(r.definedAt?.name).toBe('Base');
  });
  it('returns null/definedAt null when nothing matches', () => {
    const r = resolveCascade('flex', BP('md'), ORDERED, readP, KNOWN);
    expect(r.value).toBeNull();
    expect(r.definedAt).toBeNull();
  });
  it('composes with the box-model per-side cascade across breakpoints', () => {
    // base pt-2 + md:py-8: at md the top side is 8 (md axis beats base side);
    // at base the top side is 2.
    const cls = 'pt-2 md:py-8';
    const topAt = (bp: Breakpoint) =>
      resolveCascade(cls, bp, ORDERED, (s) => boxSideValue(s, 'padding', 'top'), KNOWN).value;
    expect(topAt(BP('md'))).toBe(8);
    expect(topAt(BASE_BREAKPOINT)).toBe(2);
  });
});

describe('removeAtLayer (reset)', () => {
  const gapMatch = (t: string) => /^gap-/.test(t);

  it('removes a base-layer token, leaving breakpoint overrides', () => {
    expect(removeAtLayer('flex gap-4 md:gap-8', BASE_BREAKPOINT, KNOWN, gapMatch)).toBe(
      'flex md:gap-8'
    );
  });
  it('removes a breakpoint-layer token, leaving the base', () => {
    expect(removeAtLayer('flex gap-4 md:gap-8', BP('md'), KNOWN, gapMatch)).toBe('flex gap-4');
  });
  it('leaves non-breakpoint modifiers (hover) alone at base', () => {
    expect(removeAtLayer('gap-4 hover:gap-2', BASE_BREAKPOINT, KNOWN, gapMatch)).toBe(
      'hover:gap-2'
    );
  });
  it('matches exact enum tokens', () => {
    const isWeight = (t: string) => ['font-normal', 'font-bold'].includes(t);
    expect(removeAtLayer('font-bold text-center', BASE_BREAKPOINT, KNOWN, isWeight)).toBe(
      'text-center'
    );
  });
});

describe('free-form spacing values', () => {
  it('reads an arbitrary spacing value, un-escaping underscores', () => {
    expect(arbitraryValue('p-[10rem] flex', 'p')).toBe('10rem');
    expect(arbitraryValue('gap-[clamp(1rem,_5vw,_4rem)]', 'gap')).toBe('clamp(1rem, 5vw, 4rem)');
    expect(arbitraryValue('pt-[12px]', 'pt')).toBe('12px');
    // The `-[` boundary keeps `p` from matching `px-[…]` / `gap-[…]`.
    expect(arbitraryValue('px-[10rem]', 'p')).toBeNull();
    expect(arbitraryValue('gap-[10rem]', 'p')).toBeNull();
  });

  it('spacingValue reads scale or arbitrary', () => {
    expect(spacingValue('p-4', 'p')).toEqual({ kind: 'scale', n: 4 });
    expect(spacingValue('p-[10rem]', 'p')).toEqual({ kind: 'arbitrary', raw: '10rem' });
    expect(spacingValue('flex', 'p')).toBeNull();
  });

  it('boxSide honors the cascade across scale and arbitrary', () => {
    // pt-[10rem] (specific, arbitrary) beats py-4 (axis, scale).
    expect(boxSide('py-4 pt-[10rem]', 'padding', 'top')).toEqual({
      kind: 'arbitrary',
      raw: '10rem',
    });
    expect(boxSide('py-4 pt-[10rem]', 'padding', 'bottom')).toEqual({ kind: 'scale', n: 4 });
    expect(boxSide('flex', 'margin', 'left')).toBeNull();
  });

  it('positionSide honors side, axis, and all-sides inset utilities', () => {
    expect(positionSide('inset-4', 'top')).toEqual({ kind: 'scale', n: 4 });
    expect(positionSide('inset-x-2 inset-y-3', 'left')).toEqual({ kind: 'scale', n: 2 });
    expect(positionSide('inset-y-3 top-[10px]', 'top')).toEqual({
      kind: 'arbitrary',
      raw: '10px',
    });
    expect(positionSide('top-auto', 'top')).toEqual({ kind: 'arbitrary', raw: 'auto' });
    expect(positionSidePrefix('right')).toBe('right');
  });

  it('reads Tailwind position presets, negatives, arbitrary values, and prefixes', () => {
    expect(positionSide('-top-4', 'top')).toEqual({ kind: 'scale', n: -4 });
    expect(positionSide('-top-full', 'top')).toEqual({ kind: 'arbitrary', raw: '-100%' });
    expect(positionSide('top-1/2', 'top')).toEqual({ kind: 'arbitrary', raw: '50%' });
    expect(
      positionSide('tw:top-(--offset)', 'top', {
        tailwindVersion: 'v4',
        utilityPrefix: 'tw:',
      })
    ).toEqual({ kind: 'arbitrary', raw: 'var(--offset)' });
    expect(
      positionSide('tw-top-[--offset]', 'top', {
        tailwindVersion: 'v3',
        utilityPrefix: 'tw-',
      })
    ).toEqual({ kind: 'arbitrary', raw: 'var(--offset)' });
  });

  it('maps v4 logical inset utilities to the physical fields', () => {
    expect(positionSide('inset-s-2', 'left', { tailwindVersion: 'v4', direction: 'ltr' })).toEqual({
      kind: 'scale',
      n: 2,
    });
    expect(positionSide('inset-s-2', 'right', { tailwindVersion: 'v4', direction: 'rtl' })).toEqual(
      { kind: 'scale', n: 2 }
    );
    expect(
      positionSide('inset-x-3', 'top', { tailwindVersion: 'v4', writingMode: 'vertical-rl' })
    ).toEqual({ kind: 'scale', n: 3 });
    expect(
      positionSide('inset-y-3', 'right', { tailwindVersion: 'v4', writingMode: 'vertical-rl' })
    ).toEqual({ kind: 'scale', n: 3 });
  });

  it('box and position side reset specs cover their fallback utility prefixes', () => {
    const paddingTop = boxSideResetSpec('padding', 'top');
    expect(paddingTop.match('pt-6')).toBe(true);
    expect(paddingTop.match('py-6')).toBe(true);
    expect(paddingTop.match('p-6')).toBe(true);
    expect(paddingTop.match('px-6')).toBe(false);
    expect(paddingTop.cssProps).toEqual([
      'padding-top',
      'padding-right',
      'padding-bottom',
      'padding-left',
    ]);

    const positionLeft = positionSideResetSpec('left');
    expect(positionLeft.match('left-4')).toBe(true);
    expect(positionLeft.match('inset-x-full')).toBe(true);
    expect(positionLeft.match('inset-1/2')).toBe(true);
    expect(positionLeft.match('inset-y-4')).toBe(false);
  });

  it('resolves a value to CSS and a display string', () => {
    expect(spacingCss({ kind: 'scale', n: 6 })).toBe('1.5rem'); // 6 × 0.25
    expect(spacingCss({ kind: 'arbitrary', raw: '10rem' })).toBe('10rem');
    expect(spacingDisplay({ kind: 'scale', n: 6 })).toBe('6');
    expect(spacingDisplay({ kind: 'arbitrary', raw: '10rem' })).toBe('10rem');
    expect(spacingDisplay(null)).toBe('0');
  });

  it('builds scale and arbitrary tokens, escaping spaces', () => {
    expect(spacingTokenFor('p', { kind: 'scale', n: 6 })).toBe('p-6');
    expect(spacingTokenFor('pt', { kind: 'arbitrary', raw: '10rem' })).toBe('pt-[10rem]');
    expect(spacingTokenFor('top', { kind: 'arbitrary', raw: 'auto' })).toBe('top-auto');
    expect(spacingTokenFor('top', { kind: 'arbitrary', raw: '100%' })).toBe('top-full');
    expect(spacingTokenFor('top', { kind: 'arbitrary', raw: '1px' })).toBe('top-px');
    expect(spacingTokenFor('top', { kind: 'arbitrary', raw: '-100%' })).toBe('-top-full');
    expect(
      spacingTokenFor('top', { kind: 'arbitrary', raw: 'var(--offset)' }, { tailwindVersion: 'v4' })
    ).toBe('top-(--offset)');
    expect(spacingTokenFor('top', { kind: 'scale', n: -13 }, { tailwindVersion: 'v3' })).toBe(
      '-top-[3.25rem]'
    );
    expect(utilityTokenFor('top-4', 'tw:')).toBe('tw:top-4');
    expect(utilityTokenFor('-top-4', 'tw:')).toBe('tw:-top-4');
    expect(utilityTokenFor('-top-4', 'tw-')).toBe('-tw-top-4');
    expect(arbitraryToken('gap', 'clamp(1rem, 5vw, 4rem)')).toBe('gap-[clamp(1rem,_5vw,_4rem)]');
  });

  it('uses the project spacing source for preview values', () => {
    expect(spacingCss({ kind: 'scale', n: 4 }, { tailwindVersion: 'v4', spacingUnit: '1px' })).toBe(
      'calc(var(--spacing, 0.25rem) * 4)'
    );
    expect(
      spacingCss({ kind: 'scale', n: 4 }, { tailwindVersion: 'v4', utilityPrefix: 'tw:' })
    ).toBe('calc(var(--tw-spacing, 0.25rem) * 4)');
    expect(
      spacingCss(
        { kind: 'scale', n: 18 },
        {
          tailwindVersion: 'v3',
          spacingScale: { 18: '4.5rem' },
        }
      )
    ).toBe('4.5rem');
  });

  describe('parseSpacingInput', () => {
    afterEach(() => vi.unstubAllGlobals());
    const stubCss = (ok: (v: string) => boolean) =>
      vi.stubGlobal('CSS', { supports: (_p: string, v: string) => ok(v) });

    it('treats a bare integer as a Tailwind scale step', () => {
      expect(parseSpacingInput('6', 'padding')).toEqual({ kind: 'scale', n: 6 });
      expect(parseSpacingInput(' 10 ', 'padding')).toEqual({ kind: 'scale', n: 10 });
    });
    it('accepts Tailwind position presets and fractions', () => {
      expect(parseSpacingInput('auto', 'top')).toEqual({ kind: 'arbitrary', raw: 'auto' });
      expect(parseSpacingInput('full', 'top')).toEqual({ kind: 'arbitrary', raw: '100%' });
      expect(parseSpacingInput('1/2', 'top')).toEqual({ kind: 'arbitrary', raw: '50%' });
      expect(parseSpacingInput('-1/2', 'top')).toEqual({ kind: 'arbitrary', raw: '-50%' });
      expect(parseSpacingInput('-full', 'top', { allowNegative: false })).toEqual({
        kind: 'invalid',
      });
    });
    it('treats a valid CSS value as arbitrary', () => {
      stubCss((v) => /^[\d.]+(px|rem|%)$/.test(v));
      expect(parseSpacingInput('10rem', 'padding')).toEqual({ kind: 'arbitrary', raw: '10rem' });
      expect(parseSpacingInput('50%', 'padding')).toEqual({ kind: 'arbitrary', raw: '50%' });
    });
    it('forgives a space between number and unit ("3 rem" → "3rem")', () => {
      stubCss((v) => /^[\d.]+(px|rem|%)$/.test(v));
      expect(parseSpacingInput('3 rem', 'padding')).toEqual({ kind: 'arbitrary', raw: '3rem' });
      expect(parseSpacingInput('10  px', 'padding')).toEqual({ kind: 'arbitrary', raw: '10px' });
    });
    it('rejects junk and empty input', () => {
      stubCss(() => false);
      expect(parseSpacingInput('40sdffsdf', 'padding')).toEqual({ kind: 'invalid' });
      expect(parseSpacingInput('', 'padding')).toEqual({ kind: 'invalid' });
    });
  });

  it('steps scale and numeric-arbitrary values, leaving calc() alone', () => {
    expect(stepSpacingValue({ kind: 'scale', n: 5 }, 1)).toEqual({ kind: 'scale', n: 6 });
    expect(stepSpacingValue(null, 1)).toEqual({ kind: 'scale', n: 1 });
    expect(stepSpacingValue({ kind: 'scale', n: 0 }, -1)).toEqual({ kind: 'scale', n: 0 }); // clamp
    expect(stepSpacingValue({ kind: 'arbitrary', raw: '10rem' }, 1)).toEqual({
      kind: 'arbitrary',
      raw: '11rem',
    });
    expect(stepSpacingValue({ kind: 'arbitrary', raw: '1.5rem' }, 1)).toEqual({
      kind: 'arbitrary',
      raw: '2.5rem',
    });
    // Non-numeric arbitraries can't be stepped — returned unchanged.
    expect(stepSpacingValue({ kind: 'arbitrary', raw: 'clamp(1rem, 5vw, 4rem)' }, 1)).toEqual({
      kind: 'arbitrary',
      raw: 'clamp(1rem, 5vw, 4rem)',
    });
  });
});

describe('arbitrary color (any format)', () => {
  it('reads hex / rgb / oklch and un-escapes underscores', () => {
    expect(arbitraryColorRaw('text-[#1a2b3c] p-4', 'text')).toBe('#1a2b3c');
    expect(arbitraryColorRaw('bg-[oklch(0.62_0.18_39)] flex', 'bg')).toBe('oklch(0.62 0.18 39)');
    expect(arbitraryColorRaw('text-[rgb(194,65,12)]', 'text')).toBe('rgb(194,65,12)');
    expect(arbitraryColorRaw('text-[var(--foreground)]', 'text')).toBe('var(--foreground)');
  });
  it('ignores non-color bracket values and absence', () => {
    expect(arbitraryColorRaw('text-[14px] leading-5', 'text')).toBeNull();
    expect(arbitraryColorRaw('p-4', 'bg')).toBeNull();
  });
  it('builds a class token, escaping spaces to underscores', () => {
    expect(colorClassToken('text', 'oklch(0.62 0.18 39)')).toBe('text-[oklch(0.62_0.18_39)]');
    expect(colorClassToken('bg', '#ffffff')).toBe('bg-[#ffffff]');
  });
  it('detects the format for match-existing', () => {
    expect(colorFormatOf('oklch(0.6 0.1 30)')).toBe('oklch');
    expect(colorFormatOf('rgb(0,0,0)')).toBe('rgb');
    expect(colorFormatOf('hsl(0,0%,0%)')).toBe('hsl');
    expect(colorFormatOf('#abcdef')).toBe('hex');
    expect(colorFormatOf('var(--x)')).toBe('hex');
  });
});

describe('color helpers', () => {
  it('reads an arbitrary hex for a color utility', () => {
    expect(arbitraryColor('flex text-[#1a2b3c] p-4', 'text')).toBe('#1a2b3c');
    expect(arbitraryColor('bg-[#fff] rounded', 'bg')).toBe('#fff');
    // named colors / absent → null (can't map back to a swatch)
    expect(arbitraryColor('text-red-500', 'text')).toBeNull();
    expect(arbitraryColor('p-4', 'bg')).toBeNull();
  });
  it('builds a color token', () => {
    expect(colorToken('text', '#000000')).toBe('text-[#000000]');
    expect(colorToken('bg', '#ff0000')).toBe('bg-[#ff0000]');
  });
});

describe('scaleValue', () => {
  it('reads <prefix>-N for the requested utility', () => {
    expect(scaleValue('bg-white p-10 flex', 'p')).toBe(10);
    expect(scaleValue('m-4 p-2', 'm')).toBe(4);
    expect(scaleValue('flex gap-6', 'gap')).toBe(6);
    expect(scaleValue('p-0', 'p')).toBe(0);
  });

  it('does not confuse prefixes (p vs px vs m)', () => {
    expect(scaleValue('px-4 py-2', 'p')).toBeNull(); // px/py are not p
    expect(scaleValue('mx-3', 'm')).toBeNull(); // mx is not m
  });

  it('ignores arbitrary and absent values', () => {
    expect(scaleValue('p-[22px]', 'p')).toBeNull();
    expect(scaleValue('flex gap-2', 'p')).toBeNull();
  });
});

describe('steppedScale', () => {
  it('steps by one integer with no skips (regression: 8→9→10)', () => {
    expect(steppedScale('p-8 flex', 'p', 1)).toBe('p-9');
    expect(steppedScale('p-9 flex', 'p', 1)).toBe('p-10');
    expect(steppedScale('p-10 flex', 'p', -1)).toBe('p-9');
    expect(steppedScale('m-3', 'm', 1)).toBe('m-4');
    expect(steppedScale('gap-5', 'gap', -1)).toBe('gap-4');
  });

  it('clamps at 0 and treats absent as 0', () => {
    expect(steppedScale('p-0', 'p', -1)).toBe('p-0');
    expect(steppedScale('flex', 'm', -1)).toBe('m-0');
    expect(steppedScale('flex', 'gap', 1)).toBe('gap-1');
  });
});

describe('activeEnumToken', () => {
  const align = ENUM_CONTROLS.find((c) => c.label === 'Align')!;
  const weight = ENUM_CONTROLS.find((c) => c.label === 'Weight')!;

  it('detects the active option token in a class string', () => {
    expect(activeEnumToken('flex text-center gap-2', align)).toBe('text-center');
    expect(activeEnumToken('font-bold text-xl', weight)).toBe('font-bold');
  });

  it('returns null when no option is present', () => {
    expect(activeEnumToken('flex gap-2', align)).toBeNull();
    // text-xl is a size, not an alignment — must not false-match.
    expect(activeEnumToken('text-xl', align)).toBeNull();
  });
});

describe('per-side box helpers', () => {
  it('resolves the cascade: side > axis > all', () => {
    // p-4 sets all sides; px-2 overrides left/right; pt-8 overrides top.
    const cls = 'p-4 px-2 pt-8';
    expect(boxSideValue(cls, 'padding', 'top')).toBe(8); // pt wins
    expect(boxSideValue(cls, 'padding', 'left')).toBe(2); // px wins
    expect(boxSideValue(cls, 'padding', 'right')).toBe(2); // px wins
    expect(boxSideValue(cls, 'padding', 'bottom')).toBe(4); // falls back to p
  });

  it('returns null for a side with no relevant utility', () => {
    expect(boxSideValue('flex gap-2', 'margin', 'top')).toBeNull();
  });

  it('builds side tokens', () => {
    expect(boxSideToken('padding', 'top', 6)).toBe('pt-6');
    expect(boxSideToken('margin', 'left', 0)).toBe('ml-0');
  });

  it('emits all four longhand inline values (N × 0.25rem)', () => {
    expect(boxInlineStyle('p-4 pt-8', 'padding')).toEqual({
      'padding-top': '2rem', // 8 × 0.25
      'padding-right': '1rem', // 4 × 0.25
      'padding-bottom': '1rem',
      'padding-left': '1rem',
    });
    // Absent utilities resolve to 0.
    expect(boxInlineStyle('flex', 'margin')['margin-top']).toBe('0rem');
  });
});

describe('SPACING_CONTROLS', () => {
  it('maps each kind to a Tailwind prefix and a CSS property', () => {
    expect(SPACING_CONTROLS.map((c) => c.kind)).toEqual(['padding', 'margin', 'gap']);
    expect(SPACING_CONTROLS.find((c) => c.kind === 'padding')).toMatchObject({
      prefix: 'p',
      css: 'padding',
    });
    expect(SPACING_CONTROLS.find((c) => c.kind === 'gap')).toMatchObject({
      prefix: 'gap',
      css: 'gap',
    });
  });
});

describe('cascade-winning (important modifier for custom CSS)', () => {
  it('markImportant appends ! once (idempotent), before any variant', () => {
    expect(markImportant('p-8')).toBe('p-8!');
    expect(markImportant('text-[#fff]')).toBe('text-[#fff]!');
    expect(markImportant('p-8!')).toBe('p-8!'); // idempotent
    expect(withVariant('md', markImportant('p-8'))).toBe('md:p-8!');
  });

  it('competesWithUnlayered: direct property match', () => {
    expect(competesWithUnlayered(['color'], ['color', 'font-size'])).toBe(true);
    expect(competesWithUnlayered(['opacity'], ['color'])).toBe(false);
  });

  it('competesWithUnlayered: a longhand edit matches a shorthand in the unlayered set', () => {
    // Custom CSS writes `margin: 0`; the box edits `margin-top`.
    expect(competesWithUnlayered(['margin-top'], ['margin'])).toBe(true);
    expect(competesWithUnlayered(['padding-left'], ['padding'])).toBe(true);
    expect(competesWithUnlayered(['background-color'], ['background'])).toBe(true);
  });

  it('competesWithUnlayered: no unlayered props → never competes', () => {
    expect(competesWithUnlayered(['color'], [])).toBe(false);
    expect(competesWithUnlayered(['color'], undefined)).toBe(false);
  });
});

describe('radius reset spec', () => {
  it('matches physical, logical, important, and configured-prefix radius utilities', () => {
    const v4 = radiusResetSpec('tw:');
    expect(v4.match('tw:rounded-tl-lg!')).toBe(true);
    expect(v4.match('!tw:rounded-s-md')).toBe(true);
    expect(v4.match('tw:rounded-[12px_8px]')).toBe(true);
    expect(v4.match('tw:hover:rounded-lg')).toBe(false);

    const v3 = radiusResetSpec('tw-');
    expect(v3.match('!tw-rounded-bl-lg')).toBe(true);
    expect(v3.match('tw-rounded')).toBe(true);
  });
});
