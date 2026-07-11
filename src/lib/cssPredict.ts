/**
 * Heuristic "what comes next" prediction for a CSS rule — the instant (no-API) layer of
 * the predictive autofill (Cursor-Tab-style). Given a rule's current declarations (plus
 * the rule's selector and the project's design tokens), guess the single most likely next
 * declaration from curated, high-precision co-occurrence patterns.
 *
 * Design notes:
 *  - High precision over recall: it stays silent unless a pattern is a strong signal. A
 *    wrong ghost is worse than no ghost.
 *  - Token-aware: when a suggested value is a spacing / color / radius and the project
 *    defines a sensibly-named custom property, it suggests `var(--token)` so additions
 *    match the system instead of hard-coding a literal.
 *  - Selector-aware: a few patterns only fire for the right kind of element (e.g.
 *    `cursor: pointer` only on clickable-looking selectors).
 *
 * Pure + side-effect free so it's unit-testable. Returns `null` when there's nothing
 * confident to suggest.
 */

export interface PredictedDecl {
  prop: string;
  value: string;
  /** Why it's suggested — shown as a faint hint next to the ghost. */
  hint?: string;
}

/** Extra context the predictor can use beyond the current declarations. */
export interface PredictContext {
  /** The rule's selector (e.g. `.btn`, `a:hover`) — for selector-gated patterns. */
  selector?: string;
  /** The project's custom-property names (`--space-4`, `--color-primary`, …) — for
   *  token-aware value suggestions. */
  variables?: string[];
}

/** One co-occurrence rule: when `needs` props are all present and `absent` are all
 *  missing (and any `guard`/`selectorMatch` predicate holds), suggest `prop: value`. */
interface Pattern {
  needs: string[];
  absent: string[];
  /** Optional guard on the present declarations' values (e.g. display is flex/grid). */
  guard?: (get: (p: string) => string | undefined) => boolean;
  /** Optional gate on the rule's selector (e.g. only clickable-looking elements). */
  selectorMatch?: (selector: string) => boolean;
  suggest: PredictedDecl;
}

const FLEXGRID = (get: (p: string) => string | undefined) => {
  const d = (get('display') ?? '').toLowerCase();
  return d.includes('flex') || d.includes('grid');
};
const IS = (get: (p: string) => string | undefined, prop: string, ...vals: string[]) => {
  const v = (get(prop) ?? '').toLowerCase().trim();
  return vals.includes(v);
};

/** A selector that looks like a clickable control — for the `cursor: pointer` hint. */
const CLICKABLE = (sel = ''): boolean =>
  /\b(button|summary)\b|\.(btn|button|cta|link|clickable)\b|\[role=["']?button/i.test(sel) ||
  /(^|[\s,>+~])a([.#:[]|\s|$)/i.test(` ${sel.trim()}`);

// Ordered by how reliably the suggestion is what the user wants next. The FIRST applicable
// pattern wins, so the strongest signals come first; the flex/grid + truncation groups are
// ordered so accepting one (Tab) surfaces the next companion.
const PATTERNS: Pattern[] = [
  // ── Flexbox / grid layout companions ──
  {
    needs: ['display'],
    absent: ['align-items'],
    guard: FLEXGRID,
    suggest: { prop: 'align-items', value: 'center', hint: 'center cross-axis' },
  },
  {
    needs: ['display'],
    absent: ['justify-content'],
    guard: FLEXGRID,
    suggest: { prop: 'justify-content', value: 'center', hint: 'center main-axis' },
  },
  {
    needs: ['display'],
    absent: ['gap'],
    guard: FLEXGRID,
    suggest: { prop: 'gap', value: '1rem', hint: 'space between items' },
  },
  {
    needs: ['display'],
    absent: ['grid-template-columns', 'grid-template', 'grid'],
    guard: (get) => (get('display') ?? '').toLowerCase().includes('grid'),
    suggest: { prop: 'grid-template-columns', value: 'repeat(2, 1fr)', hint: 'columns' },
  },

  // ── z-index needs a positioning context to take effect ──
  {
    needs: ['z-index'],
    absent: ['position'],
    suggest: { prop: 'position', value: 'relative', hint: 'z-index needs positioning' },
  },

  // ── Positioning offsets ──
  {
    needs: ['position'],
    absent: ['top', 'inset', 'bottom'],
    guard: (get) => IS(get, 'position', 'sticky'),
    suggest: { prop: 'top', value: '0', hint: 'stick to top' },
  },
  {
    needs: ['position'],
    absent: ['inset', 'top', 'right', 'bottom', 'left'],
    guard: (get) => IS(get, 'position', 'absolute', 'fixed'),
    suggest: { prop: 'inset', value: '0', hint: 'pin to edges' },
  },

  // ── Typography ──
  {
    needs: ['font-size'],
    absent: ['line-height'],
    suggest: { prop: 'line-height', value: '1.5', hint: 'readable leading' },
  },

  // ── Single-line truncation: the ellipsis trio (white-space → overflow → text-overflow) ──
  {
    needs: ['white-space'],
    absent: ['overflow', 'text-overflow'],
    guard: (get) => (get('white-space') ?? '').includes('nowrap'),
    suggest: { prop: 'overflow', value: 'hidden', hint: 'for truncation' },
  },
  {
    needs: ['white-space', 'overflow'],
    absent: ['text-overflow'],
    guard: (get) =>
      (get('white-space') ?? '').includes('nowrap') && (get('overflow') ?? '').includes('hidden'),
    suggest: { prop: 'text-overflow', value: 'ellipsis', hint: 'truncate with …' },
  },
  {
    needs: ['text-overflow'],
    absent: ['white-space'],
    suggest: { prop: 'white-space', value: 'nowrap', hint: 'for truncation' },
  },
  {
    needs: ['text-overflow'],
    absent: ['overflow'],
    suggest: { prop: 'overflow', value: 'hidden', hint: 'for truncation' },
  },

  // ── Transitions / animations ──
  {
    needs: ['transition-property'],
    absent: ['transition-duration'],
    suggest: { prop: 'transition-duration', value: '0.2s' },
  },
  {
    needs: ['transition-property', 'transition-duration'],
    absent: ['transition-timing-function'],
    suggest: { prop: 'transition-timing-function', value: 'ease' },
  },
  {
    needs: ['animation-name'],
    absent: ['animation-duration'],
    suggest: { prop: 'animation-duration', value: '1s' },
  },

  // ── Backgrounds ──
  {
    needs: ['background-image'],
    absent: ['background-size'],
    suggest: { prop: 'background-size', value: 'cover' },
  },
  {
    needs: ['background-image', 'background-size'],
    absent: ['background-position'],
    suggest: { prop: 'background-position', value: 'center' },
  },

  // ── Clipping (but NOT a truncation rule, which uses overflow:hidden too) ──
  {
    needs: ['overflow'],
    absent: ['border-radius'],
    guard: (get) =>
      (get('overflow') ?? '').includes('hidden') && !(get('white-space') ?? '').includes('nowrap'),
    suggest: { prop: 'border-radius', value: '8px', hint: 'round the clip' },
  },

  // ── Interactivity ──
  {
    needs: ['cursor'],
    absent: ['user-select'],
    guard: (get) => IS(get, 'cursor', 'pointer'),
    suggest: { prop: 'user-select', value: 'none' },
  },
  {
    needs: [],
    absent: ['cursor'],
    selectorMatch: CLICKABLE,
    suggest: { prop: 'cursor', value: 'pointer', hint: 'clickable' },
  },
];

// Property groups whose value benefits from a design token when one exists.
const SPACING_PROPS = new Set([
  'gap',
  'row-gap',
  'column-gap',
  'padding',
  'margin',
  'inset',
  'top',
  'right',
  'bottom',
  'left',
]);
const COLOR_PROPS = new Set([
  'color',
  'background-color',
  'border-color',
  'outline-color',
  'fill',
  'stroke',
]);

/** Pick the most generic project token matching `match`, as `var(--name)`, or null. */
function pickToken(variables: string[] | undefined, match: RegExp): string | null {
  if (!variables?.length) return null;
  const hits = variables.filter((v) => match.test(v));
  if (!hits.length) return null;
  // Shortest name first (the base token, e.g. `--space` over `--space-xl`), then
  // alphabetical for stable output.
  hits.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return `var(${hits[0]})`;
}

/** Swap a literal suggested value for a project design token when one clearly fits.
 *  Conservative: never tokenizes `0`/keywords, and only when a sensibly-named var exists. */
function tokenizeValue(prop: string, value: string, variables?: string[]): string {
  const v = value.trim();
  if (!variables?.length || v === '0' || v.startsWith('var(') || !/[\d#]/.test(v)) return value;
  if (prop === 'border-radius') return pickToken(variables, /(radius|rounded|corner)/i) ?? value;
  if (SPACING_PROPS.has(prop)) return pickToken(variables, /(spac|gap)/i) ?? value;
  if (COLOR_PROPS.has(prop))
    return (
      pickToken(variables, /(colou?r|text|\bbg\b|background|primary|accent|brand|surface|fg)/i) ??
      value
    );
  return value;
}

/**
 * Predict the single most likely next declaration for a rule, or `null`. `decls` is the
 * rule's current declarations (property + value). A property already present (or one the
 * caller passes in `exclude`, e.g. just-dismissed) is never suggested. `ctx` supplies the
 * selector + project tokens for selector-gated and token-aware suggestions.
 */
export function predictNextDeclaration(
  decls: { prop: string; value: string }[],
  exclude: ReadonlySet<string> = new Set(),
  ctx: PredictContext = {}
): PredictedDecl | null {
  if (decls.length === 0) return null;
  const byProp = new Map(decls.map((d) => [d.prop.trim().toLowerCase(), d.value]));
  const get = (p: string) => byProp.get(p.toLowerCase());
  const has = (p: string) => byProp.has(p.toLowerCase());
  const selector = ctx.selector ?? '';

  for (const pat of PATTERNS) {
    if (!pat.needs.every(has)) continue;
    if (!pat.absent.every((p) => !has(p))) continue;
    if (pat.guard && !pat.guard(get)) continue;
    if (pat.selectorMatch && !pat.selectorMatch(selector)) continue;
    const sugg = pat.suggest;
    if (exclude.has(sugg.prop.toLowerCase())) continue;
    const value = tokenizeValue(sugg.prop.toLowerCase(), sugg.value, ctx.variables);
    return value === sugg.value ? sugg : { ...sugg, value };
  }
  return null;
}
