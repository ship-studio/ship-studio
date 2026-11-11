import { describe, expect, it } from 'vitest';
import { BASE_BREAKPOINT, breakpointPrefixes, DEFAULT_BREAKPOINTS } from './edit';
import {
  backgroundImageForLayer,
  backgroundImageFromTokens,
  isSimpleCssBackgroundUrl,
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
});
