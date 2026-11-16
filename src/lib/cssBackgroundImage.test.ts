import { describe, expect, it } from 'vitest';
import { twMerge } from 'tailwind-merge';
import {
  BASE_BREAKPOINT,
  breakpointPrefixes,
  DEFAULT_BREAKPOINTS,
  markImportant,
  removeAtLayer,
  utilityTokenFor,
} from './edit';
import {
  alignBackgroundValues,
  backgroundResetSpec,
  backgroundLayerToken,
  backgroundListToken,
  insertBackgroundLayerSettings,
  removeBackgroundLayerValue,
  reorderBackgroundLayerValues,
  updateBackgroundLayerValue,
  backgroundImageForLayer,
  backgroundImageFromTokens,
  backgroundListFromTokens,
  isSimpleCssBackgroundUrl,
  parseBackgroundStack,
  serializeBackgroundStack,
  splitCssCommaList,
} from './cssBackgroundImage';
import type { LayerContext } from './edit';

const breakpoints = [BASE_BREAKPOINT, ...DEFAULT_BREAKPOINTS];
const md = breakpoints.find((breakpoint) => breakpoint.name === 'md')!;

function layer(bp = md): LayerContext {
  return {
    bp,
    ordered: breakpoints,
    known: breakpointPrefixes(breakpoints),
  };
}

describe('CSS background image values', () => {
  it('does not infer untyped image or color values as background size and normalizes repeat modes', () => {
    expect(backgroundListFromTokens('bg-[url(/hero.png)]', 'size')).toBeNull();
    expect(backgroundListFromTokens('bg-[#123456]', 'size')).toBeNull();
    expect(backgroundListFromTokens('bg-repeat-round', 'repeat')).toEqual(['round']);
    expect(backgroundListFromTokens('bg-repeat-space', 'repeat')).toEqual(['space']);
  });
  it('allows commas inside an unquoted URL and rejects comma-separated image layers', () => {
    expect(isSimpleCssBackgroundUrl('url(/images/hero,wide.png)')).toBe(true);
    expect(isSimpleCssBackgroundUrl('url(data:image/svg+xml,<svg,a>)')).toBe(true);
    expect(isSimpleCssBackgroundUrl('url(/hero.png), linear-gradient(red, blue)')).toBe(false);
  });

  it('reads complex arbitrary image values without changing their layers or URL underscores', () => {
    expect(
      backgroundImageFromTokens(
        'bg-[image:linear-gradient(45deg,_url(/hero_asset.png)_0%,_transparent_100%)]'
      )
    ).toBe('linear-gradient(45deg, url(/hero_asset.png) 0%, transparent 100%)');
  });

  it('uses the nearest image token at the active breakpoint before the stale preview value', () => {
    expect(
      backgroundImageForLayer(
        'bg-[url(/base.png)] md:bg-[url(/md_hero.png)]',
        layer(),
        'url(/stale.png)'
      )
    ).toBe('url(/md_hero.png)');
  });

  it('does not restore a removed active-breakpoint image from the stale snapshot', () => {
    expect(
      backgroundImageForLayer(
        'bg-[url(/base.png)] md:bg-red-700',
        layer(),
        'url(/stale.png)',
        'bg-[url(/base.png)] md:bg-[url(/md-old.png)]'
      )
    ).toBe('url(/base.png)');

    expect(
      backgroundImageForLayer(
        'md:bg-red-700',
        layer(),
        'url(/stale.png)',
        'md:bg-[url(/md-old.png)]'
      )
    ).toBeUndefined();
  });

  it('respects configured Tailwind prefixes and falls back to computed CSS', () => {
    expect(
      backgroundImageForLayer('tw:bg-[url(/hero.png)]', {
        ...layer(BASE_BREAKPOINT),
        utilityPrefix: 'tw:',
      })
    ).toBe('url(/hero.png)');
    expect(backgroundImageForLayer('bg-red-500', layer(), 'url(/authored-in-css.png)')).toBe(
      'url(/authored-in-css.png)'
    );
  });

  it('splits CSS lists only at top-level commas and round-trips URL data', () => {
    const value =
      'url("/images/hero_(wide)_asset.png?label=a,b&size=2"), linear-gradient(35deg, rgb(1 2 3 / 40%) 0%, var(--accent) 100%)';
    expect(splitCssCommaList(value)).toEqual([
      'url("/images/hero_(wide)_asset.png?label=a,b&size=2")',
      'linear-gradient(35deg, rgb(1 2 3 / 40%) 0%, var(--accent) 100%)',
    ]);
    const parsed = parseBackgroundStack(value);
    expect(parsed.reason).toBeUndefined();
    expect(serializeBackgroundStack(parsed.layers)).toBe(value);
    expect(backgroundImageFromTokens('bg-[image:url("/hero_(wide)_asset.png?x=a,b")]')).toBe(
      'url("/hero_(wide)_asset.png?x=a,b")'
    );
  });

  it('keeps solid colours stackable as flat gradients and writes list-valued utilities', () => {
    const parsed = parseBackgroundStack('#4f46e5');
    expect(parsed.layers).toEqual([
      { id: 'solid-0', kind: 'solid', value: 'linear-gradient(#4f46e5, #4f46e5)' },
    ]);
    expect(backgroundLayerToken(serializeBackgroundStack(parsed.layers))).toBe(
      'bg-[image:linear-gradient(#4f46e5,_#4f46e5)]'
    );
    expect(backgroundListToken('size', ['cover', 'auto 20px'])).toBe(
      '[background-size:cover,_auto_20px]'
    );
  });

  it('expands CSS list repetition before layer reorder/delete operations', () => {
    expect(alignBackgroundValues(['cover', 'contain'], 4)).toEqual([
      'cover',
      'contain',
      'cover',
      'contain',
    ]);
    const values = alignBackgroundValues(['left top', 'center'], 3);
    const [first] = values.splice(0, 1);
    values.splice(2, 0, first);
    expect(values).toEqual(['center', 'left top', 'left top']);
    expect(
      insertBackgroundLayerSettings(
        {
          size: ['cover', 'contain'],
          position: ['left top'],
          repeat: ['no-repeat'],
          attachment: ['fixed'],
        },
        1
      )
    ).toEqual({
      size: ['auto', 'cover', 'contain'],
      position: ['0% 0%', 'left top'],
      repeat: ['repeat', 'no-repeat'],
      attachment: ['scroll', 'fixed'],
    });
    expect(reorderBackgroundLayerValues(['cover', 'contain'], 4, 0, 3)).toEqual([
      'contain',
      'cover',
      'contain',
      'cover',
    ]);
    expect(updateBackgroundLayerValue(['cover', 'contain', '100px'], 2, 0, 'auto')).toEqual([
      'auto',
      'contain',
      '100px',
    ]);
    expect(removeBackgroundLayerValue(['cover', 'contain', '100px'], 2, 0)).toEqual([
      'contain',
      '100px',
    ]);
  });

  it('keeps active variants, configured prefixes, and important modifiers while replacing image utilities', () => {
    const current = 'bg-red-500 bg-cover md:tw:bg-[url(/old.png)] md:bg-contain text-lg';
    const stripped = removeAtLayer(
      current,
      md,
      breakpointPrefixes(breakpoints),
      (token) =>
        backgroundResetSpec('image', 'tw:').match(token) ||
        backgroundResetSpec('size', 'tw:').match(token)
    );
    expect(stripped).toBe('bg-red-500 bg-cover text-lg');
    expect(
      removeAtLayer(
        'tw:bg-cover tw:bg-red-500',
        BASE_BREAKPOINT,
        breakpointPrefixes(breakpoints),
        backgroundResetSpec('size', 'tw:').match
      )
    ).toBe('tw:bg-red-500');
    expect(twMerge('bg-red-500 bg-[url(/old.png)] bg-[image:linear-gradient(red,_blue)]')).toBe(
      'bg-red-500 bg-[image:linear-gradient(red,_blue)]'
    );
    expect(twMerge('[background-size:cover] [background-size:contain]')).toBe(
      '[background-size:contain]'
    );
    expect(utilityTokenFor('bg-[image:linear-gradient(red,_blue)]', 'tw-')).toBe(
      'tw-bg-[image:linear-gradient(red,_blue)]'
    );
    expect(markImportant('tw-bg-[image:linear-gradient(red,_blue)]', 'v3')).toBe(
      '!tw-bg-[image:linear-gradient(red,_blue)]'
    );
    expect(markImportant('tw:[background-size:cover]', 'v4')).toBe('tw:[background-size:cover]!');
  });

  it('shows a read-only reason for expressions it cannot safely round-trip', () => {
    expect(parseBackgroundStack('image-set(url(/a.png) 1x, url(/a@2x.png) 2x)').reason).toContain(
      'cannot safely round-trip'
    );
    expect(parseBackgroundStack('conic-gradient(from 20deg, red, blue)').reason).toContain(
      'cannot safely round-trip'
    );
    expect(parseBackgroundStack('var(--custom-background-image)').reason).toContain(
      'cannot safely round-trip'
    );
    expect(parseBackgroundStack('linear-gradient(red 0% 20%, blue 100%)').reason).toContain(
      'cannot safely round-trip'
    );
  });

  it('keeps repeating gradient behavior intact while editing its stops', () => {
    const parsed = parseBackgroundStack('repeating-linear-gradient(45deg, red 0%, blue 10%)');
    expect(parsed.reason).toBeUndefined();
    expect(serializeBackgroundStack(parsed.layers)).toBe(
      'repeating-linear-gradient(45deg, red 0%, blue 10%)'
    );
  });
});
