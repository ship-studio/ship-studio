/**
 * A compact list of common CSS property names for the cascade editor's "add
 * property" / property-name autocomplete, plus the CSS-wide value keywords. Kept
 * self-contained (no dependency on the soon-retired `cssControls.ts`).
 */

export const CSS_PROPERTIES: string[] = [
  // Box model
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'box-sizing',
  'aspect-ratio',
  'overflow',
  'overflow-x',
  'overflow-y',
  'overflow-clip-margin',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'margin-block',
  'margin-block-start',
  'margin-block-end',
  'margin-inline',
  'margin-inline-start',
  'margin-inline-end',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'padding-block',
  'padding-block-start',
  'padding-block-end',
  'padding-inline',
  'padding-inline-start',
  'padding-inline-end',
  // Logical sizing
  'inline-size',
  'block-size',
  'min-inline-size',
  'min-block-size',
  'max-inline-size',
  'max-block-size',
  // Positioning
  'display',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'inset',
  'inset-block',
  'inset-block-start',
  'inset-block-end',
  'inset-inline',
  'inset-inline-start',
  'inset-inline-end',
  'z-index',
  'float',
  'clear',
  'isolation',
  'visibility',
  'content-visibility',
  'contain',
  // Flexbox
  'flex',
  'flex-direction',
  'flex-flow',
  'flex-wrap',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'order',
  // Grid
  'grid',
  'grid-template',
  'grid-template-columns',
  'grid-template-rows',
  'grid-template-areas',
  'grid-area',
  'grid-column',
  'grid-column-start',
  'grid-column-end',
  'grid-row',
  'grid-row-start',
  'grid-row-end',
  'grid-auto-flow',
  'grid-auto-columns',
  'grid-auto-rows',
  // Box alignment
  'gap',
  'row-gap',
  'column-gap',
  'justify-content',
  'justify-items',
  'justify-self',
  'align-content',
  'align-items',
  'align-self',
  'place-content',
  'place-items',
  'place-self',
  // Typography
  'color',
  'font',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'font-stretch',
  'font-feature-settings',
  'font-variation-settings',
  'font-kerning',
  'font-display',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'tab-size',
  'text-align',
  'text-align-last',
  'text-justify',
  'text-transform',
  'text-indent',
  'text-decoration',
  'text-decoration-line',
  'text-decoration-color',
  'text-decoration-style',
  'text-decoration-thickness',
  'text-underline-offset',
  'text-underline-position',
  'text-overflow',
  'text-shadow',
  'text-wrap',
  'text-rendering',
  'text-orientation',
  'white-space',
  'word-break',
  'overflow-wrap',
  'word-wrap',
  'hyphens',
  'line-break',
  'vertical-align',
  'writing-mode',
  'direction',
  'unicode-bidi',
  'quotes',
  '-webkit-line-clamp',
  '-webkit-text-stroke',
  '-webkit-text-fill-color',
  '-webkit-font-smoothing',
  // Backgrounds
  'background',
  'background-color',
  'background-image',
  'background-size',
  'background-position',
  'background-position-x',
  'background-position-y',
  'background-repeat',
  'background-attachment',
  'background-clip',
  'background-origin',
  'background-blend-mode',
  // Borders
  'border',
  'border-width',
  'border-style',
  'border-color',
  'border-radius',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-left-radius',
  'border-bottom-right-radius',
  'border-block',
  'border-block-start',
  'border-block-end',
  'border-inline',
  'border-inline-start',
  'border-inline-end',
  'border-collapse',
  'border-spacing',
  'border-image',
  'border-image-source',
  'border-image-slice',
  'outline',
  'outline-color',
  'outline-width',
  'outline-style',
  'outline-offset',
  'box-shadow',
  'box-decoration-break',
  // Effects & transforms
  'opacity',
  'filter',
  'backdrop-filter',
  'mix-blend-mode',
  'transform',
  'transform-origin',
  'transform-style',
  'transform-box',
  'perspective',
  'perspective-origin',
  'backface-visibility',
  'translate',
  'rotate',
  'scale',
  'transition',
  'transition-property',
  'transition-duration',
  'transition-timing-function',
  'transition-delay',
  'transition-behavior',
  'animation',
  'animation-name',
  'animation-duration',
  'animation-timing-function',
  'animation-delay',
  'animation-iteration-count',
  'animation-direction',
  'animation-fill-mode',
  'animation-play-state',
  'animation-composition',
  'will-change',
  'offset',
  // SVG
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'clip-path',
  'clip-rule',
  'mask',
  'mask-image',
  'shape-rendering',
  'vector-effect',
  // Interaction & misc
  'cursor',
  'pointer-events',
  'user-select',
  'touch-action',
  'appearance',
  'resize',
  'caret-color',
  'accent-color',
  'color-scheme',
  'forced-color-adjust',
  'scroll-behavior',
  'scroll-margin',
  'scroll-padding',
  'scroll-snap-type',
  'scroll-snap-align',
  'overscroll-behavior',
  'scrollbar-width',
  'scrollbar-color',
  'scrollbar-gutter',
  'content',
  'counter-reset',
  'counter-increment',
  'list-style',
  'list-style-type',
  'list-style-position',
  'list-style-image',
  'object-fit',
  'object-position',
  'table-layout',
  'caption-side',
  'empty-cells',
  'columns',
  'column-count',
  'column-width',
  'column-gap',
  'column-rule',
  'column-span',
  'column-fill',
  'break-before',
  'break-after',
  'break-inside',
  'page-break-before',
  'page-break-after',
  'mix-blend-mode',
  'image-rendering',
  'shape-outside',
  'shape-margin',
  'all',
];

/** CSS-wide keywords valid on any property. */
export const CSS_WIDE_KEYWORDS = ['inherit', 'initial', 'unset', 'revert', 'revert-layer'];

/** Keyword value suggestions per property (the enumerated values that property
 *  accepts). Not exhaustive — the high-frequency ones that benefit from autocomplete. */
const VALUE_KEYWORDS: Record<string, string[]> = {
  display: [
    'block',
    'inline',
    'inline-block',
    'flex',
    'inline-flex',
    'grid',
    'inline-grid',
    'flow-root',
    'contents',
    'none',
  ],
  position: ['static', 'relative', 'absolute', 'fixed', 'sticky'],
  'box-sizing': ['border-box', 'content-box'],
  'flex-direction': ['row', 'row-reverse', 'column', 'column-reverse'],
  'flex-wrap': ['nowrap', 'wrap', 'wrap-reverse'],
  'justify-content': [
    'flex-start',
    'flex-end',
    'center',
    'space-between',
    'space-around',
    'space-evenly',
    'start',
    'end',
    'stretch',
  ],
  'align-items': ['stretch', 'flex-start', 'flex-end', 'center', 'baseline', 'start', 'end'],
  'align-content': ['stretch', 'flex-start', 'flex-end', 'center', 'space-between', 'space-around'],
  'align-self': ['auto', 'stretch', 'flex-start', 'flex-end', 'center', 'baseline'],
  'text-align': ['left', 'right', 'center', 'justify', 'start', 'end'],
  'font-weight': [
    '100',
    '200',
    '300',
    '400',
    '500',
    '600',
    '700',
    '800',
    '900',
    'normal',
    'bold',
    'lighter',
    'bolder',
  ],
  'font-style': ['normal', 'italic', 'oblique'],
  'text-transform': ['none', 'uppercase', 'lowercase', 'capitalize'],
  'text-decoration': ['none', 'underline', 'overline', 'line-through'],
  'text-overflow': ['clip', 'ellipsis'],
  'white-space': ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces'],
  'word-break': ['normal', 'break-all', 'keep-all', 'break-word'],
  'overflow-wrap': ['normal', 'break-word', 'anywhere'],
  overflow: ['visible', 'hidden', 'scroll', 'auto', 'clip'],
  'overflow-x': ['visible', 'hidden', 'scroll', 'auto', 'clip'],
  'overflow-y': ['visible', 'hidden', 'scroll', 'auto', 'clip'],
  visibility: ['visible', 'hidden', 'collapse'],
  cursor: [
    'pointer',
    'default',
    'text',
    'move',
    'grab',
    'grabbing',
    'not-allowed',
    'wait',
    'help',
    'crosshair',
    'zoom-in',
    'zoom-out',
    'none',
  ],
  'pointer-events': ['auto', 'none'],
  'user-select': ['auto', 'none', 'text', 'all'],
  resize: ['none', 'both', 'horizontal', 'vertical'],
  'object-fit': ['fill', 'contain', 'cover', 'none', 'scale-down'],
  'border-style': [
    'none',
    'solid',
    'dashed',
    'dotted',
    'double',
    'groove',
    'ridge',
    'inset',
    'outset',
  ],
  'list-style-type': ['none', 'disc', 'circle', 'square', 'decimal'],
  'background-repeat': ['repeat', 'no-repeat', 'repeat-x', 'repeat-y', 'space', 'round'],
  'background-size': ['auto', 'cover', 'contain'],
  'background-position': ['center', 'top', 'bottom', 'left', 'right'],
  'flex-grow': ['0', '1'],
  'flex-shrink': ['0', '1'],
  'mix-blend-mode': ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference'],
};

/** Property names whose value is typically a color (so `var(--…)` colors / named
 *  colors are worth suggesting). */
const COLOR_PROPS = new Set([
  'color',
  'background',
  'background-color',
  'border-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'fill',
  'stroke',
  'caret-color',
  'text-decoration-color',
  'column-rule-color',
  'accent-color',
]);

export function isColorProperty(property: string): boolean {
  return COLOR_PROPS.has(property.trim().toLowerCase());
}

/** Properties whose value references a `@keyframes` animation by name (so the
 *  project's keyframe names are worth suggesting first). */
const ANIMATION_PROPS = new Set(['animation', 'animation-name']);

export function isAnimationProperty(property: string): boolean {
  return ANIMATION_PROPS.has(property.trim().toLowerCase());
}

/**
 * Value suggestions for a declaration, in priority order: for animation properties
 * the project's `@keyframes` names first; then the project's CSS variables (as
 * `var(--x)`, color vars first for color properties), the property's enumerated
 * keywords, then the CSS-wide keywords. The caller filters by typed text.
 */
export function suggestValues(
  property: string,
  variables: string[] = [],
  animations: string[] = []
): string[] {
  const p = property.trim().toLowerCase();
  const vars = variables.map((v) => (v.startsWith('var(') ? v : `var(${v})`));
  const anims = ANIMATION_PROPS.has(p) ? animations : [];
  const keywords = VALUE_KEYWORDS[p] ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of [...anims, ...vars, ...keywords, ...CSS_WIDE_KEYWORDS]) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

const NUMERIC_VALUE = /^(-?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i;

/**
 * A single numeric CSS value (`24px`, `1.5rem`, `50`, `-10%`, `.5`) parsed into its
 * number, unit, and decimal places — for drag-to-scrub. Returns null for anything
 * that isn't exactly one number (+ optional unit), e.g. `0 auto`, `1px solid red`,
 * `calc(…)`, `var(…)`.
 */
export function parseNumericValue(
  value: string
): { num: number; unit: string; decimals: number } | null {
  const m = NUMERIC_VALUE.exec(value.trim());
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (!Number.isFinite(num)) return null;
  const dot = m[1].indexOf('.');
  const decimals = dot < 0 ? 0 : m[1].length - dot - 1;
  return { num, unit: m[2], decimals };
}

/** Format a scrubbed number back to a CSS value, trimming float noise to `decimals`
 *  places (min 0) and re-attaching the unit. */
export function formatNumericValue(num: number, unit: string, decimals: number): string {
  const fixed = num.toFixed(Math.max(0, Math.min(4, decimals)));
  // Drop trailing zeros / dot so 24.0 → 24, 1.50 → 1.5.
  const clean = decimals > 0 ? fixed.replace(/\.?0+$/, '') : fixed;
  return `${clean}${unit}`;
}

const COLOR_FN = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/i;
const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NAMED_COLORS = new Set([
  'black',
  'white',
  'red',
  'green',
  'blue',
  'yellow',
  'orange',
  'purple',
  'pink',
  'gray',
  'grey',
  'cyan',
  'magenta',
  'teal',
  'navy',
  'maroon',
  'olive',
  'lime',
  'aqua',
  'silver',
  'gold',
  'transparent',
  'currentcolor',
]);

/** The value rendered as a swatch color, or null when it isn't a plain color. */
export function colorSwatch(value: string): string | null {
  const v = value.trim();
  if (HEX.test(v) || COLOR_FN.test(v) || NAMED_COLORS.has(v.toLowerCase())) return v;
  return null;
}

/** Suggest property names for a typed fragment (prefix-first, then substring). */
export function suggestProperties(query: string, limit = 8): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return CSS_PROPERTIES.slice(0, limit);
  const starts = CSS_PROPERTIES.filter((p) => p.startsWith(q));
  const contains = CSS_PROPERTIES.filter((p) => !p.startsWith(q) && p.includes(q));
  return [...new Set([...starts, ...contains])].slice(0, limit);
}

/** Common at-rule preludes offered when adding/wrapping with an `@` affordance. */
export const COMMON_AT_RULES: string[] = [
  '@media (max-width: 768px)',
  '@media (min-width: 768px)',
  '@media (max-width: 480px)',
  '@media (min-width: 1024px)',
  '@media (min-width: 1280px)',
  '@media (prefers-color-scheme: dark)',
  '@media (prefers-color-scheme: light)',
  '@media (prefers-reduced-motion: reduce)',
  '@media (hover: hover)',
  '@media print',
  '@supports (display: grid)',
];

/** Suggest at-rule preludes for a typed fragment (always lets you keep your own text). */
export function suggestAtRules(query: string, limit = 8): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return COMMON_AT_RULES.slice(0, limit);
  return COMMON_AT_RULES.filter((a) => a.toLowerCase().includes(q)).slice(0, limit);
}

/** Common `@media` conditions (without the `@media` keyword) for editing an at-rule. */
export const COMMON_MEDIA_CONDITIONS: string[] = [
  '(max-width: 768px)',
  '(min-width: 768px)',
  '(max-width: 480px)',
  '(min-width: 1024px)',
  '(min-width: 1280px)',
  '(prefers-color-scheme: dark)',
  '(prefers-color-scheme: light)',
  '(prefers-reduced-motion: reduce)',
  '(hover: hover)',
  'print',
];

/** Suggest media conditions for a typed fragment. */
export function suggestMediaConditions(query: string, limit = 8): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return COMMON_MEDIA_CONDITIONS.slice(0, limit);
  return COMMON_MEDIA_CONDITIONS.filter((a) => a.toLowerCase().includes(q)).slice(0, limit);
}
