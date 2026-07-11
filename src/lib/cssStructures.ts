/**
 * The catalog behind the cascade card's smart "+ Add" menu (Direction 1). Instead
 * of the abstract "add parent / add child", the menu speaks in author intent:
 *
 *   ALSO STYLE (nested) — a related rule: pseudo-classes/elements, descendants,
 *                         combinators, :has()/:is()/:not(). Inserted via nesting.
 *   ONLY WHEN (condition) — make the rule conditional/scoped: @media, @container,
 *                           @supports, @layer, @scope. Inserted by wrapping (or, in
 *                           a nested rule, by nesting the at-rule).
 *
 * Every item carries search keywords so the whole modern-CSS surface is reachable
 * by typing intent ("dark", "container", "has"). Free text is always honored too —
 * type any selector or `@`-rule and it's normalized and inserted.
 */

export type StructureKind = 'nest' | 'wrap';

export interface StructureItem {
  /** What the menu row shows, e.g. `&:hover` or `@container (min-width: …)`. */
  label: string;
  /** Passed to onNest (a selector) for `nest`, or onWrap (an at-rule prelude) for `wrap`. */
  insert: string;
  kind: StructureKind;
  /** A short plain-language gloss shown dimmed beside the label. */
  hint?: string;
  /** Extra search terms beyond the label words. */
  keywords?: string[];
}

/** ALSO STYLE — related rules added by CSS nesting. */
export const NEST_ITEMS: StructureItem[] = [
  { label: '&:hover', insert: '&:hover', kind: 'nest', hint: 'on hover', keywords: ['state'] },
  {
    label: '&:focus-visible',
    insert: '&:focus-visible',
    kind: 'nest',
    hint: 'keyboard focus',
    keywords: ['focus', 'a11y', 'accessibility'],
  },
  {
    label: '&:active',
    insert: '&:active',
    kind: 'nest',
    hint: 'while pressed',
    keywords: ['press'],
  },
  { label: '&:focus', insert: '&:focus', kind: 'nest', keywords: ['focus'] },
  {
    label: '&:focus-within',
    insert: '&:focus-within',
    kind: 'nest',
    hint: 'a child is focused',
    keywords: ['focus'],
  },
  {
    label: '&:disabled',
    insert: '&:disabled',
    kind: 'nest',
    keywords: ['form', 'input', 'state'],
  },
  { label: '&:checked', insert: '&:checked', kind: 'nest', keywords: ['form', 'input', 'toggle'] },
  {
    label: '&::before',
    insert: '&::before',
    kind: 'nest',
    hint: 'pseudo-element',
    keywords: ['content', 'pseudo'],
  },
  {
    label: '&::after',
    insert: '&::after',
    kind: 'nest',
    hint: 'pseudo-element',
    keywords: ['content', 'pseudo'],
  },
  {
    label: '&::placeholder',
    insert: '&::placeholder',
    kind: 'nest',
    keywords: ['input', 'form', 'pseudo'],
  },
  {
    label: '&::selection',
    insert: '&::selection',
    kind: 'nest',
    hint: 'highlighted text',
    keywords: ['pseudo'],
  },
  {
    label: '& .child',
    insert: '& .child',
    kind: 'nest',
    hint: 'a descendant',
    keywords: ['inside', 'descendant'],
  },
  {
    label: '& > .item',
    insert: '& > .item',
    kind: 'nest',
    hint: 'a direct child',
    keywords: ['child', 'combinator'],
  },
  {
    label: '&:has(.active)',
    insert: '&:has(.active)',
    kind: 'nest',
    hint: 'when it contains…',
    keywords: ['parent', 'contains', 'relational'],
  },
  {
    label: '&:not(.disabled)',
    insert: '&:not(.disabled)',
    kind: 'nest',
    hint: 'exclude',
    keywords: ['negation'],
  },
  {
    label: '&:is(h1, h2)',
    insert: '&:is(h1, h2)',
    kind: 'nest',
    hint: 'matches any',
    keywords: ['matches'],
  },
  {
    label: '&:where(.a, .b)',
    insert: '&:where(.a, .b)',
    kind: 'nest',
    hint: 'zero specificity',
    keywords: ['matches'],
  },
  {
    label: '& > :nth-child(even)',
    insert: '& > :nth-child(even)',
    kind: 'nest',
    hint: 'even children',
    keywords: ['nth', 'alternate', 'stripe', 'zebra', 'child', 'rows'],
  },
  {
    label: '& > :nth-child(odd)',
    insert: '& > :nth-child(odd)',
    kind: 'nest',
    hint: 'odd children',
    keywords: ['nth', 'alternate', 'stripe', 'zebra', 'child', 'rows'],
  },
  {
    label: '&:nth-child(even)',
    insert: '&:nth-child(even)',
    kind: 'nest',
    hint: 'this, when even sibling',
    keywords: ['nth', 'alternate', 'stripe', '2n'],
  },
  {
    label: '&:nth-child(odd)',
    insert: '&:nth-child(odd)',
    kind: 'nest',
    hint: 'every other',
    keywords: ['nth', 'alternate', 'stripe'],
  },
  {
    label: '&:nth-child(3n)',
    insert: '&:nth-child(3n)',
    kind: 'nest',
    hint: 'every 3rd',
    keywords: ['nth', 'grid'],
  },
  {
    label: '&:first-child',
    insert: '&:first-child',
    kind: 'nest',
    keywords: ['nth', 'position'],
  },
  { label: '&:last-child', insert: '&:last-child', kind: 'nest', keywords: ['nth', 'position'] },
  {
    label: '& + .sibling',
    insert: '& + .sibling',
    kind: 'nest',
    hint: 'next sibling',
    keywords: ['adjacent', 'combinator'],
  },
  {
    label: '& ~ .sibling',
    insert: '& ~ .sibling',
    kind: 'nest',
    hint: 'following siblings',
    keywords: ['general', 'combinator'],
  },
  {
    label: '&:target',
    insert: '&:target',
    kind: 'nest',
    hint: '#hash target',
    keywords: ['anchor'],
  },
  { label: '&:empty', insert: '&:empty', kind: 'nest', keywords: ['no children'] },
];

/** KEYFRAME STEPS — the stops inside a `@keyframes` rule. Each is a nested block
 *  (`from { … }`, `50% { … }`) holding the declarations for that point in time. */
export const KEYFRAME_STEP_ITEMS: StructureItem[] = [
  { label: 'from', insert: 'from', kind: 'nest', hint: 'start (0%)', keywords: ['0', 'begin'] },
  { label: 'to', insert: 'to', kind: 'nest', hint: 'end (100%)', keywords: ['100', 'finish'] },
  { label: '0%', insert: '0%', kind: 'nest', hint: 'start', keywords: ['from', 'begin'] },
  { label: '25%', insert: '25%', kind: 'nest', keywords: ['quarter'] },
  { label: '50%', insert: '50%', kind: 'nest', hint: 'midpoint', keywords: ['half', 'middle'] },
  { label: '75%', insert: '75%', kind: 'nest', keywords: ['three quarter'] },
  { label: '100%', insert: '100%', kind: 'nest', hint: 'end', keywords: ['to', 'finish'] },
];

/** A `@keyframes <name>` / `@-webkit-keyframes <name>` rule — its body is keyframe
 *  steps, not declarations or ordinary nested rules. */
export function isKeyframesSelector(selector: string): boolean {
  return /^@(-[a-z]+-)?keyframes\b/i.test(selector.trim());
}

/** The animation name of a `@keyframes <name>` selector (`@keyframes reveal` → `reveal`),
 *  or null if it isn't a keyframes selector. Used to suggest names to `animation`. */
export function keyframesName(selector: string): string | null {
  const m = /^@(?:-[a-z]+-)?keyframes\s+(.+)$/i.exec(selector.trim());
  return m ? m[1].trim() : null;
}

/** Recommended standalone rules offered by "Add selector" beyond plain class/tag
 *  selectors — top-level `@`-rules the editor can fully author. Currently just
 *  `@keyframes` (animations); kept here so the list is easy to grow. */
export const NEW_RULE_ITEMS: StructureItem[] = [
  {
    label: '@keyframes animate',
    insert: '@keyframes animate',
    kind: 'nest',
    hint: 'animation steps',
    keywords: ['animation', 'motion', 'animate', 'transition', 'keyframe'],
  },
];

/** Normalize free-typed keyframe-step text: a bare number → `N%`, `from`/`to` kept,
 *  an existing `%` kept. Returns null for empty/invalid. */
export function classifyKeyframeStep(text: string): StructureItem | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  if (t === 'from' || t === 'to') return { label: t, insert: t, kind: 'nest' };
  // `50` → `50%`, `50%` → `50%`. Allow a comma group (`0%, 100%`).
  const norm = t
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (/^\d+(\.\d+)?%?$/.test(p) ? (p.endsWith('%') ? p : `${p}%`) : p))
    .join(', ');
  if (!norm) return null;
  return { label: norm, insert: norm, kind: 'nest' };
}

/** ONLY WHEN — conditions/scopes that gate when the rule applies. */
export const WRAP_ITEMS: StructureItem[] = [
  {
    label: '@media (max-width: 768px)',
    insert: '@media (max-width: 768px)',
    kind: 'wrap',
    hint: 'tablet & down',
    keywords: ['responsive', 'breakpoint', 'mobile', 'small'],
  },
  {
    label: '@media (max-width: 480px)',
    insert: '@media (max-width: 480px)',
    kind: 'wrap',
    hint: 'phones',
    keywords: ['responsive', 'breakpoint', 'mobile', 'small'],
  },
  {
    label: '@media (min-width: 1024px)',
    insert: '@media (min-width: 1024px)',
    kind: 'wrap',
    hint: 'desktop & up',
    keywords: ['responsive', 'breakpoint', 'large', 'desktop'],
  },
  {
    label: '@media (prefers-color-scheme: dark)',
    insert: '@media (prefers-color-scheme: dark)',
    kind: 'wrap',
    hint: 'dark mode',
    keywords: ['theme', 'night'],
  },
  {
    label: '@media (prefers-reduced-motion: reduce)',
    insert: '@media (prefers-reduced-motion: reduce)',
    kind: 'wrap',
    hint: 'reduced motion',
    keywords: ['a11y', 'accessibility', 'animation'],
  },
  {
    label: '@media (hover: hover)',
    insert: '@media (hover: hover)',
    kind: 'wrap',
    hint: 'pointer can hover',
    keywords: ['pointer', 'touch'],
  },
  {
    label: '@media print',
    insert: '@media print',
    kind: 'wrap',
    keywords: ['paper'],
  },
  {
    label: '@container (min-width: 480px)',
    insert: '@container (min-width: 480px)',
    kind: 'wrap',
    hint: 'container query',
    keywords: ['cq', 'responsive', 'intrinsic'],
  },
  {
    label: '@container (max-width: 480px)',
    insert: '@container (max-width: 480px)',
    kind: 'wrap',
    hint: 'container query',
    keywords: ['cq', 'responsive', 'intrinsic'],
  },
  {
    label: '@supports (display: grid)',
    insert: '@supports (display: grid)',
    kind: 'wrap',
    hint: 'feature query',
    keywords: ['fallback', 'progressive'],
  },
  {
    label: '@supports selector(&:has(*))',
    insert: '@supports selector(&:has(*))',
    kind: 'wrap',
    hint: 'selector support',
    keywords: ['fallback', 'progressive', 'has'],
  },
  {
    label: '@layer components',
    insert: '@layer components',
    kind: 'wrap',
    hint: 'cascade layer',
    keywords: ['priority', 'order'],
  },
  {
    label: '@scope (.card)',
    insert: '@scope (.card)',
    kind: 'wrap',
    hint: 'scoped styles',
    keywords: ['boundary', 'isolate'],
  },
  {
    label: '@media (orientation: landscape)',
    insert: '@media (orientation: landscape)',
    kind: 'wrap',
    keywords: ['responsive', 'rotate'],
  },
];

/** A complete condition prelude (`@media (…)`, `@media print`, `@container style(…)`,
 *  `@supports (…)`, with optional `and`/`or`/`,` chains) followed by whitespace and the
 *  rest. Used to tell when the user has finished the condition and is now typing the
 *  selector. */
const COMPLETE_CONDITION =
  /^(@[a-z-]+(?:\s+[a-z][\w-]*|\s*(?:style\s*)?\([^)]*\)(?:\s*(?:and|or|,)\s*(?:style\s*)?\([^)]*\))*))\s+(.*)$/i;

/** How the smart selector field reads a half-typed rule prelude, so it can suggest the
 *  right thing: a condition catalog while you compose the `@…`, then class names once
 *  the condition is complete and you've moved on to the selector. */
export interface ParsedPrelude {
  /** The complete `@…` condition if one has been finished, else null. */
  condition: string | null;
  /** The selector portion typed so far (after the condition, or the whole text). */
  selector: string;
  /** Which part the user is composing right now — drives which suggestions to show. */
  stage: 'condition' | 'selector';
}

/**
 * Parse a smart-selector field value into `[condition] [selector]`. Typing `@…` is the
 * condition stage (suggest conditions); once a full condition is followed by whitespace
 * the rest is the selector stage (suggest classes). Text not starting with `@` is a
 * plain selector.
 */
export function parseRulePrelude(text: string): ParsedPrelude {
  const m = COMPLETE_CONDITION.exec(text);
  if (m) {
    return { condition: m[1].trim(), selector: m[2].trim(), stage: 'selector' };
  }
  if (text.trimStart().startsWith('@')) {
    return { condition: null, selector: '', stage: 'condition' };
  }
  return { condition: null, selector: text.trim(), stage: 'selector' };
}

function matches(item: StructureItem, q: string): boolean {
  if (!q) return true;
  const hay = `${item.label} ${item.hint ?? ''} ${(item.keywords ?? []).join(' ')}`.toLowerCase();
  return hay.includes(q);
}

/** Filter one group of constructs by a query (label, hint, and keywords). */
export function searchStructures(
  items: StructureItem[],
  query: string,
  limit = 12
): StructureItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((it) => matches(it, q)).slice(0, limit);
}

/**
 * Interpret free-typed text as a construct so power users can type anything:
 *   `@…`                     → a condition (wrap)
 *   `&…`, `:`/`::…`, `> + ~` → a nested rule (nest), normalized to start with `&`
 *   `.x` / `tag` / `#id`     → a nested descendant (`& .x`)
 * Returns null for empty input.
 */
export function classifyFreeText(text: string): StructureItem | null {
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith('@')) {
    return { label: t, insert: t, kind: 'wrap' };
  }
  let insert: string;
  if (t.startsWith('&')) insert = t;
  else if (t.startsWith(':'))
    insert = `&${t}`; // :hover → &:hover (covers ::before too)
  else insert = `& ${t}`; // .x / tag / #id / > .x → & .x
  return { label: insert, insert, kind: 'nest' };
}
