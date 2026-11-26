import { describe, expect, it } from 'vitest';
import {
  colorContrastContexts,
  contrastRatio,
  contrastThreshold,
  resolveColorVariable,
  validateColorContrastSnapshot,
  type ColorContrastSnapshot,
} from './colorContrast';

const opaquePage = (overrides: Partial<ColorContrastSnapshot> = {}): ColorContrastSnapshot => ({
  layers: [
    {
      backgroundColor: 'rgba(0, 0, 0, 0)',
      hasBackgroundImage: false,
      opacity: 1,
      mixBlendMode: 'normal',
      backgroundBlendMode: 'normal',
      hasFilter: false,
    },
    {
      backgroundColor: 'rgb(255, 255, 255)',
      hasBackgroundImage: false,
      opacity: 1,
      mixBlendMode: 'normal',
      backgroundBlendMode: 'normal',
      hasFilter: false,
    },
  ],
  truncated: false,
  fontSizePx: 16,
  fontWeight: 400,
  hasText: true,
  ...overrides,
});

describe('color contrast calculations', () => {
  it('uses WCAG luminance, composites foreground alpha, and rejects unknown backgrounds', () => {
    expect(contrastRatio('#000', '#fff')).toBe(21);
    expect(contrastRatio('rgba(0, 0, 0, 0.5)', '#fff')).toBeCloseTo(3.97665, 4);
    expect(contrastRatio('red', 'rgba(255, 255, 255, 0.5)')).toBeNull();
    expect(contrastRatio('not a color', '#fff')).toBeNull();
  });

  it('matches published WCAG reference ratios on either side of the AA line', () => {
    // #767676 is the classic lightest grey that passes AA on white; #777777 fails.
    expect(contrastRatio('#767676', '#fff')).toBeCloseTo(4.5422, 4);
    expect(contrastRatio('#777777', '#fff')).toBeCloseTo(4.4781, 4);
    // Ratio is symmetric in its arguments.
    expect(contrastRatio('#fff', '#767676')).toBeCloseTo(4.5422, 4);
    // Linear segment of the sRGB transfer (channel <= 0.04045): rgb(10 10 10)
    // has L = (10/255)/12.92, so its ratio on black is (L + 0.05) / 0.05.
    expect(contrastRatio('rgb(10 10 10)', '#000')).toBeCloseTo((10 / 255 / 12.92 + 0.05) / 0.05, 6);
    // Pure primaries weight by the Rec. 709 coefficients.
    expect(contrastRatio('#f00', '#000')).toBeCloseTo((0.2126 + 0.05) / 0.05, 6);
    expect(contrastRatio('#0f0', '#000')).toBeCloseTo((0.7152 + 0.05) / 0.05, 6);
    expect(contrastRatio('#00f', '#000')).toBeCloseTo((0.0722 + 0.05) / 0.05, 6);
  });

  it('uses WCAG AA and AAA thresholds for text and graphics', () => {
    expect(contrastThreshold('normal-text', 'AA')).toBe(4.5);
    expect(contrastThreshold('normal-text', 'AAA')).toBe(7);
    expect(contrastThreshold('large-text', 'AA')).toBe(3);
    expect(contrastThreshold('large-text', 'AAA')).toBe(4.5);
    expect(contrastThreshold('graphics', 'AA')).toBe(3);
    expect(contrastThreshold('graphics', 'AAA')).toBe(3);
  });

  it('resolves nested variable aliases and fallbacks while stopping cycles', () => {
    const variables = [
      { name: '--ink', value: '#111' },
      { name: '--text', value: 'var(--ink)' },
      { name: '--cycle-a', value: 'var(--cycle-b)' },
      { name: '--cycle-b', value: 'var(--cycle-a)' },
    ];
    expect(resolveColorVariable('var(--text)', variables)).toBe('#111');
    expect(resolveColorVariable('var(--missing, var(--ink))', variables)).toBe('#111');
    expect(resolveColorVariable('var(--cycle-a)', variables)).toBeNull();
    expect(resolveColorVariable('var(--cycle-a, white)', variables)).toBeNull();
    expect(
      resolveColorVariable('var(--theme, white)', [
        { name: '--theme', value: '#fff' },
        { name: '--theme', value: '#000' },
      ])
    ).toBeNull();
    expect(
      resolveColorVariable('var(--theme)', [
        { name: '--theme', value: '#fff' },
        { name: '--theme', value: '#000' },
      ])
    ).toBeNull();
  });

  it('uses root tokens without scope and selector-scoped overrides when provided', () => {
    const variables = [
      { name: '--background', value: '#fff', selector: ':root' },
      { name: '--background', value: '#000', selector: '.dark' },
      { name: '--brand', value: 'var(--background)', selector: ':root' },
      { name: '--brand', value: 'var(--background)', selector: '.dark' },
    ];

    expect(resolveColorVariable('var(--background)', variables)).toBe('#fff');
    expect(resolveColorVariable('var(--brand)', variables)).toBe('#fff');
    expect(resolveColorVariable('var(--background)', variables, '.dark')).toBe('#000');
    expect(resolveColorVariable('var(--brand)', variables, '.dark')).toBe('#000');
    expect(resolveColorVariable('var(--background)', variables, '.light')).toBe('#fff');
  });

  it('builds text and graphic contexts from element and ancestor backgrounds', () => {
    const contexts = colorContrastContexts(
      opaquePage({
        layers: [
          {
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            hasBackgroundImage: false,
            opacity: 1,
            mixBlendMode: 'normal',
            backgroundBlendMode: 'normal',
            hasFilter: false,
          },
          {
            backgroundColor: 'rgb(255, 255, 255)',
            hasBackgroundImage: false,
            opacity: 1,
            mixBlendMode: 'normal',
            backgroundBlendMode: 'normal',
            hasFilter: false,
          },
        ],
        fontSizePx: 18.6666667,
        fontWeight: 700,
      })
    );

    expect(contexts.text.category).toBe('large-text');
    expect(contexts.text.backgroundColor).toBe('rgb(127.5 127.5 127.5)');
    expect(contexts.graphics.category).toBe('graphics');
    expect(contexts.graphics.backgroundColor).toBe('rgb(255 255 255)');
  });

  it('marks unsupported render effects and validates iframe snapshot fields', () => {
    const snapshot = opaquePage({
      layers: [
        {
          backgroundColor: 'rgba(0, 0, 0, 0)',
          hasBackgroundImage: true,
          opacity: 1,
          mixBlendMode: 'normal',
          backgroundBlendMode: 'normal',
          hasFilter: false,
        },
        ...opaquePage().layers.slice(1),
      ],
    });
    expect(colorContrastContexts(snapshot).text.unavailableReason).toContain('Background images');
    expect(validateColorContrastSnapshot(snapshot)).toEqual(snapshot);
    expect(
      validateColorContrastSnapshot({
        ...snapshot,
        layers: [{ ...snapshot.layers[0], opacity: 2 }],
      })
    ).toBeUndefined();
  });

  it('does not substitute a guessed page color when every backdrop is translucent', () => {
    const translucent = opaquePage({
      layers: opaquePage().layers.map((layer) => ({
        ...layer,
        backgroundColor: 'rgba(0, 0, 0, 0.25)',
      })),
    });
    const contexts = colorContrastContexts(translucent);
    expect(contexts.text.backgroundColor).toBeUndefined();
    expect(contexts.text.unavailableReason).toContain('No opaque background');
  });

  it('ignores background effects behind an opaque nearer layer but checks ancestor group effects', () => {
    const hiddenImage = opaquePage({
      layers: [
        { ...opaquePage().layers[0], backgroundColor: 'rgba(0, 0, 0, 0)' },
        { ...opaquePage().layers[1], backgroundColor: '#fff' },
        {
          ...opaquePage().layers[1],
          backgroundColor: 'rgba(0, 0, 0, 0)',
          hasBackgroundImage: true,
          backgroundBlendMode: 'multiply',
        },
      ],
    });
    expect(colorContrastContexts(hiddenImage).text.backgroundColor).toBe('rgb(255 255 255)');

    const ancestorOpacity = opaquePage({
      layers: [
        ...opaquePage().layers,
        { ...opaquePage().layers[1], opacity: 0.9, hasBackgroundImage: true },
      ],
    });
    expect(colorContrastContexts(ancestorOpacity).text.unavailableReason).toContain('Opacity');
  });

  it('uses the strictest visible text category and marks mixed descendant styles unavailable', () => {
    const mixed = opaquePage({
      fontSizePx: 24,
      fontWeight: 400,
      strictestTextCategory: 'normal-text',
      hasMixedTextStyle: true,
    });
    const contexts = colorContrastContexts(mixed);
    expect(contexts.text.category).toBe('normal-text');
    expect(contexts.text.unavailableReason).toContain('Descendant text');
    expect(contexts.text.backgroundColor).toBeUndefined();
  });

  it('fails closed for group edits and allows a selected-only snapshot', () => {
    const group = opaquePage({ groupCount: 3 });
    expect(colorContrastContexts(group).text.unavailableReason).toContain(
      'multiple rendered instances'
    );
    expect(colorContrastContexts(group).graphics.unavailableReason).toContain(
      'multiple rendered instances'
    );
    expect(colorContrastContexts(group).text.backgroundColor).toBeUndefined();
    expect(colorContrastContexts({ ...group, groupCount: 1 }).text.backgroundColor).toBe(
      'rgb(255 255 255)'
    );
  });
});

// #1211: culori throws on function values carrying a length; contrast must
// treat them as "unknown", not crash the picker that renders the ratio.
describe('contrastRatio with non-color function values', () => {
  it('returns null instead of throwing', () => {
    expect(contrastRatio('translateY(-4px)', '#ffffff')).toBeNull();
    expect(contrastRatio('#000000', 'blur(4px)')).toBeNull();
  });
});
