/**
 * Visual editor — frontend bindings for the className source resolver and
 * surgical write-back commands (`src-tauri/src/commands/edit.rs`).
 *
 * The model: a clicked element's `class` attribute is the authored Tailwind
 * `className` (verbatim in dev), so we resolve its source location by searching
 * the project for that literal, scored by element context.
 */

import { invoke } from '@tauri-apps/api/core';

/** Signature of a clicked element, produced by the in-iframe selection script. */
export interface ElementSignature {
  className: string;
  tagName: string;
  text?: string;
  ancestorClasses: string[];
  rect?: { top: number; left: number; width: number; height: number };
  /** Rendered color/background from getComputedStyle — lets the color picker seed
   *  from the actual color even when it comes from a named class, var, or
   *  inheritance (not an arbitrary `text-[#…]`). */
  computedColor?: string;
  computedBackgroundColor?: string;
  /** CSS properties this element gets from UNLAYERED rules (custom CSS that beats
   *  Tailwind utilities). Edits touching these need the important modifier to win. */
  unlayeredProps?: string[];
  /** The element's raw `src` attribute (images) — the image resolver's search key. */
  attrSrc?: string | null;
  /** The absolute URL the browser actually loaded for an `<img>` (resolves
   *  relative paths and srcset) — used only to render the panel's thumbnail. */
  currentSrc?: string | null;
}

/** A source location of a className literal. */
export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

/** Outcome of resolving an element to a source location (mirrors the Rust enum). */
export type Resolution =
  | {
      status: 'resolved';
      file: string;
      line: number;
      column: number;
      class_name: string;
      /** How the match was reached: "unique" | "tag" | "ancestor". */
      confidence: string;
    }
  | {
      /** The class string appears at multiple identical source spots — editable as a
       *  group (write all) or one at a time. */
      status: 'multi';
      locations: SourceLocation[];
      class_name: string;
    }
  | { status: 'read_only'; reason: string };

/** Resolve a clicked element to its source `className` location. */
export function resolveClassnameSource(
  projectPath: string,
  signature: ElementSignature
): Promise<Resolution> {
  return invoke<Resolution>('resolve_classname_source', { projectPath, signature });
}

// ───────────────────────────── Text content ─────────────────────────────────
//
// Inline text editing reuses class resolution as the anchor: once an element's
// className pins one source location, the static text inside that tag is editable.
// No `multi` rung — repeated elements usually carry per-instance copy.

/** Outcome of resolving an element's text content to source (mirrors the Rust enum). */
export type TextResolution =
  | {
      status: 'resolved';
      file: string;
      line: number;
      column: number;
      /** Current static text (trimmed) — the write-back's drift baseline. */
      text: string;
      confidence: string;
    }
  | { status: 'read_only'; reason: string };

/** Resolve a clicked element to its editable text source. */
export function resolveTextSource(
  projectPath: string,
  signature: ElementSignature
): Promise<TextResolution> {
  return invoke<TextResolution>('resolve_text_source', { projectPath, signature });
}

/** Surgically replace one static text run, verifying it still equals `oldText`.
 *  `column` pins the exact run when identical text repeats on the same line. */
export function applyTextEdit(
  projectPath: string,
  file: string,
  line: number,
  column: number,
  oldText: string,
  newText: string
): Promise<void> {
  return invoke('apply_text_edit', { projectPath, file, line, column, oldText, newText });
}

// ───────────────────────────── Image source ─────────────────────────────────
//
// "Replace image" follows the text-editing model: resolve the clicked <img> to
// the static `src="…"` literal in source (class-anchored, falling back to a
// search for the rendered src value), then surgically rewrite that literal.

/** Outcome of resolving an image's `src` to source (mirrors the Rust enum). */
export type ImageResolution =
  | {
      status: 'resolved';
      file: string;
      line: number;
      column: number;
      /** Current static src value — the write-back's drift baseline. */
      src: string;
      confidence: string;
    }
  | { status: 'read_only'; reason: string };

/** Resolve a clicked image to its editable `src` source literal. */
export function resolveImageSource(
  projectPath: string,
  signature: ElementSignature
): Promise<ImageResolution> {
  return invoke<ImageResolution>('resolve_image_source', { projectPath, signature });
}

/** Surgically replace one static `src` literal, verifying it still equals `oldSrc`.
 *  `column` pins the exact attribute when identical values share a line. */
export function applySrcEdit(
  projectPath: string,
  file: string,
  line: number,
  column: number,
  oldSrc: string,
  newSrc: string
): Promise<void> {
  return invoke('apply_src_edit', { projectPath, file, line, column, oldSrc, newSrc });
}

// ───────────────────────────── Breakpoints ──────────────────────────────────
//
// The editor edits one responsive *layer* at a time. A layer is either the base
// (unprefixed) utilities — which apply at all widths — or a Tailwind breakpoint
// variant like `md:` which applies from its min-width up. Readers/builders stay
// base-layer-only; we make them variant-aware by stripping/adding the prefix at
// the edges (see `tokensForVariant` / `withVariant`), never by changing the
// readers themselves.

/** A responsive layer the editor can target. Base = the unprefixed layer. */
export interface Breakpoint {
  /** Display name, e.g. "Base", "sm", "md". */
  name: string;
  /** Tailwind variant prefix without the colon (`md`), or null for the base layer. */
  prefix: string | null;
  /** Min-width in px the breakpoint activates at (0 for base). */
  minPx: number;
}

/** The base (unprefixed) layer — applies at all widths. Prepended to detected breakpoints. */
export const BASE_BREAKPOINT: Breakpoint = { name: 'Base', prefix: null, minPx: 0 };

/** Tailwind's default breakpoints — the fallback when detection finds none. */
export const DEFAULT_BREAKPOINTS: Breakpoint[] = [
  { name: 'sm', prefix: 'sm', minPx: 640 },
  { name: 'md', prefix: 'md', minPx: 768 },
  { name: 'lg', prefix: 'lg', minPx: 1024 },
  { name: 'xl', prefix: 'xl', minPx: 1280 },
  { name: '2xl', prefix: '2xl', minPx: 1536 },
];

/** Detect the project's Tailwind breakpoints (real responsive ones only — the
 *  caller prepends `BASE_BREAKPOINT`). */
export function detectBreakpoints(projectPath: string): Promise<Breakpoint[]> {
  return invoke<Breakpoint[]>('detect_breakpoints', { projectPath });
}

/** Whether Tailwind is actually wired into the project's build (so the utility
 *  classes the editor writes will compile). Gates the editor — no Tailwind, no editor. */
export function isTailwindActive(projectPath: string): Promise<boolean> {
  return invoke<boolean>('is_tailwind_active', { projectPath });
}

/** Whether the project depends on React. Used to gate the editor for Vite
 *  projects: the className→source resolver only indexes `.tsx`/`.jsx`, so a
 *  Vite + Vue/Svelte project would otherwise show an edit button that can't
 *  write back. Meta-frameworks (Next.js) are gated by project type instead. */
export function projectUsesReact(projectPath: string): Promise<boolean> {
  return invoke<boolean>('project_uses_react', { projectPath });
}

/** The set of breakpoint prefixes used to recognize variant tokens. */
export function breakpointPrefixes(breakpoints: Breakpoint[]): Set<string> {
  return new Set(breakpoints.map((b) => b.prefix).filter((p): p is string => p !== null));
}

/**
 * The tokens of `className` that belong to one breakpoint layer, prefix stripped,
 * re-joined as a class string the unprefixed readers understand. `known` is the
 * set of breakpoint prefixes in play (e.g. {sm, md, lg}).
 *
 * - Base layer (`prefix === null`): keep only tokens whose leading modifier is NOT
 *   a known breakpoint — so `hover:`/`focus:`/`dark:` tokens stay (they're part of
 *   the base width layer), but `md:p-4` is excluded.
 * - Breakpoint layer (`prefix === 'md'`): keep only tokens led by exactly `md:`,
 *   with that one prefix stripped (`md:hover:p-4` → `hover:p-4`).
 *
 * Stripping is anchored to the leading modifier only, matched against `known` —
 * never a blind split, so colon-bearing arbitrary values (`bg-[url(http://…)]`)
 * are never mis-parsed (their lead isn't a known breakpoint, so they fall to base).
 */
export function tokensForVariant(
  className: string,
  prefix: string | null,
  known: Set<string>
): string {
  const out: string[] = [];
  for (const token of className.split(/\s+/)) {
    if (!token) continue;
    const colon = token.indexOf(':');
    const lead = colon === -1 ? null : token.slice(0, colon);
    if (prefix === null) {
      if (lead !== null && known.has(lead)) continue; // a breakpoint token — not base
      out.push(token);
    } else if (lead === prefix) {
      out.push(token.slice(colon + 1)); // strip exactly this breakpoint prefix
    }
  }
  return out.join(' ');
}

/** Prefix a bare token with a breakpoint variant (`md` + `p-6` → `md:p-6`); base
 *  returns the token unchanged. */
export function withVariant(prefix: string | null, token: string): string {
  return prefix ? `${prefix}:${token}` : token;
}

/**
 * Resolve a value across the Tailwind min-width cascade: starting at `bp`, walk
 * DOWN through smaller breakpoints to Base, returning the first layer where `read`
 * finds a value — plus which breakpoint defined it (powers the inherited-vs-set
 * indicator in one pass). `read` receives the prefix-stripped tokens for a single
 * layer. `ordered` is all breakpoints (INCLUDING Base) — order doesn't matter, we
 * sort the at-or-below subset descending here.
 */
export function resolveCascade<T>(
  className: string,
  bp: Breakpoint,
  ordered: Breakpoint[],
  read: (scopedTokens: string) => T | null | undefined,
  known: Set<string>
): { value: T | null; definedAt: Breakpoint | null } {
  const chain = ordered.filter((b) => b.minPx <= bp.minPx).sort((a, b) => b.minPx - a.minPx);
  for (const layer of chain) {
    const value = read(tokensForVariant(className, layer.prefix, known));
    if (value !== null && value !== undefined) {
      return { value: value as T, definedAt: layer };
    }
  }
  return { value: null, definedAt: null };
}

/** The breakpoint layer the panel reads/writes, bundled with what `resolveCascade`
 *  needs. Built once in the panel and threaded to each control so they read the
 *  effective value at the active breakpoint (and know which layer defined it). */
export interface LayerContext {
  bp: Breakpoint;
  ordered: Breakpoint[];
  known: Set<string>;
}

/** `resolveCascade` bound to a `LayerContext` — the effective value at the layer's
 *  breakpoint plus where it was defined (for the inherited-vs-set indicator). */
export function readLayer<T>(
  className: string,
  layer: LayerContext,
  read: (scopedTokens: string) => T | null | undefined
): { value: T | null; definedAt: Breakpoint | null } {
  return resolveCascade(className, layer.bp, layer.ordered, read, layer.known);
}

/**
 * Remove the tokens at one breakpoint layer whose prefix-stripped base matches
 * `match` (used by Reset to clear a property at the active breakpoint). Only that
 * layer is touched: at base, a known-breakpoint token like `md:p-4` is left alone,
 * and `hover:`/other modifiers stay (their base keeps the modifier, so an anchored
 * matcher like `/^gap-/` won't hit `hover:gap-4`).
 */
export function removeAtLayer(
  className: string,
  bp: Breakpoint,
  known: Set<string>,
  match: (layerBase: string) => boolean
): string {
  return className
    .split(/\s+/)
    .filter(Boolean)
    .filter((tok) => {
      const colon = tok.indexOf(':');
      const lead = colon === -1 ? null : tok.slice(0, colon);
      let layerBase: string | null;
      if (bp.prefix === null) {
        layerBase = lead !== null && known.has(lead) ? null : tok; // base keeps full token
      } else {
        layerBase = lead === bp.prefix ? tok.slice(colon + 1) : null;
      }
      return layerBase === null || !match(layerBase);
    })
    .join(' ');
}

/** Describes how to reset one control's value: which active-layer tokens to remove,
 *  and which CSS properties to neutralize in the live preview so the reverted
 *  (inherited or default) value shows. */
export interface ResetSpec {
  match: (layerBase: string) => boolean;
  cssProps: string[];
}

/** Reset spec for a scale-or-arbitrary spacing utility (gap, opacity). Matches
 *  `<prefix>-<n>` / `<prefix>-[…]` but not sub-utilities like `gap-x-…`. */
export function spacingResetSpec(prefix: string, cssProp: string): ResetSpec {
  return { match: (t) => new RegExp(`^${prefix}-(\\d+$|\\[)`).test(t), cssProps: [cssProp] };
}

/** Reset spec for an arbitrary color utility (`text-[…]` / `bg-[…]`) — only the
 *  bracketed form, so it never touches `text-center` / `text-xl`. */
export function colorResetSpec(prefix: string, cssProp: string): ResetSpec {
  return { match: (t) => new RegExp(`^${prefix}-\\[`).test(t), cssProps: [cssProp] };
}

/** Reset spec for an enum control — removes whichever of its options is set, and
 *  neutralizes every CSS property its options drive. */
export function enumResetSpec(control: EnumControl): ResetSpec {
  return {
    match: (t) => control.options.some((o) => o.token === t),
    cssProps: [...new Set(control.options.flatMap((o) => Object.keys(o.style)))],
  };
}

/**
 * Current scale value of a Tailwind spacing utility (`<prefix>-N`) in a class
 * string, or null if absent / arbitrary (`p-[..]`). `prefix` is a plain utility
 * key like `p`, `m`, `gap` (no regex metacharacters).
 */
export function scaleValue(className: string, prefix: string): number | null {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const token of className.split(/\s+/)) {
    const m = re.exec(token);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * The `<prefix>-N` token one integer step up/down from the class's current
 * value, clamped at 0. Plain integer stepping (no sparse scale) — Tailwind v4
 * generates spacing dynamically so every integer is valid, and the common v3
 * range (0–12) is contiguous too. Avoids the surprising skips (8 → 10) a
 * hardcoded scale produced.
 */
export function steppedScale(className: string, prefix: string, dir: 1 | -1): string {
  const next = Math.max(0, (scaleValue(className, prefix) ?? 0) + dir);
  return `${prefix}-${next}`;
}

/** Tailwind's default spacing unit: `<prefix>-n` resolves to n × 0.25rem. */
export const SPACING_REM = 0.25;

export type SpacingKind = 'padding' | 'margin' | 'gap';

/**
 * Spacing controls the panel renders, in order. `prefix` is the Tailwind utility
 * key; `css` is the inline-style property used for JIT-independent live preview
 * (its value equals what the class resolves to, so Save hands off cleanly).
 */
export const SPACING_CONTROLS: {
  kind: SpacingKind;
  label: string;
  prefix: string;
  css: string;
}[] = [
  { kind: 'padding', label: 'Padding', prefix: 'p', css: 'padding' },
  { kind: 'margin', label: 'Margin', prefix: 'm', css: 'margin' },
  { kind: 'gap', label: 'Gap', prefix: 'gap', css: 'gap' },
];

export type Side = 'top' | 'right' | 'bottom' | 'left';
export type BoxType = 'padding' | 'margin';

const BOX_PREFIX: Record<BoxType, string> = { padding: 'p', margin: 'm' };
const SIDE_LETTER: Record<Side, string> = { top: 't', right: 'r', bottom: 'b', left: 'l' };

/**
 * Effective scale value of one side of a box (padding/margin), honoring the
 * Tailwind cascade: a side-specific utility (`pt-`) beats an axis utility
 * (`py-`/`px-`) which beats the all-sides utility (`p-`). Returns null when no
 * relevant utility is present (i.e. the side is at its default of 0).
 */
export function boxSideValue(className: string, type: BoxType, side: Side): number | null {
  const p = BOX_PREFIX[type];
  const axis = side === 'top' || side === 'bottom' ? `${p}y` : `${p}x`;
  const specific = scaleValue(className, `${p}${SIDE_LETTER[side]}`);
  return specific ?? scaleValue(className, axis) ?? scaleValue(className, p);
}

/** The Tailwind class token that sets one side, e.g. `pt-6`, `ml-2`. */
export function boxSideToken(type: BoxType, side: Side, n: number): string {
  return `${BOX_PREFIX[type]}${SIDE_LETTER[side]}-${n}`;
}

/**
 * Inline longhand style patch for ALL four sides of a box, computed from a class
 * string. Used for JIT-independent live preview — we always set the four
 * longhands (padding-top, …) so the preview is correct even when Tailwind hasn't
 * compiled the utility, and longhands avoid shorthand/longhand clobbering.
 */
export function boxInlineStyle(className: string, type: BoxType): Record<string, string> {
  const out: Record<string, string> = {};
  for (const side of ['top', 'right', 'bottom', 'left'] as Side[]) {
    out[`${type}-${side}`] = `${(boxSideValue(className, type, side) ?? 0) * SPACING_REM}rem`;
  }
  return out;
}

// ───────────────────── Free-form spacing values ─────────────────────────────
//
// A spacing field accepts either a Tailwind scale step (a bare integer → `p-6`)
// or an arbitrary CSS length (`10rem`, `12px`, `50%`, `clamp(…)` → `p-[10rem]`).
// Invalid input is rejected via CSS.supports so the field can flag a bad unit.

/** A resolved spacing value: a Tailwind scale step, or an arbitrary CSS length. */
export type SpacingValue = { kind: 'scale'; n: number } | { kind: 'arbitrary'; raw: string };

/** The arbitrary value inside `<prefix>-[…]` (e.g. `p-[10rem]` → `10rem`), with
 *  Tailwind's `_` un-escaped to spaces. Null if absent. `prefix` is a plain key
 *  (`p`, `pt`, `gap`); the `-[` boundary keeps `p` from matching `px-[…]`. */
export function arbitraryValue(className: string, prefix: string): string | null {
  const m = new RegExp(`(?:^|\\s)${prefix}-\\[([^\\]]+)\\]`).exec(className);
  return m ? m[1].replace(/_/g, ' ') : null;
}

/** The value of a spacing utility for one prefix — scale (`p-6`) or arbitrary
 *  (`p-[10rem]`), whichever is present. Null if neither. */
export function spacingValue(className: string, prefix: string): SpacingValue | null {
  const n = scaleValue(className, prefix);
  if (n !== null) return { kind: 'scale', n };
  const raw = arbitraryValue(className, prefix);
  return raw !== null ? { kind: 'arbitrary', raw } : null;
}

/** Effective value of one box side honoring the cascade (side > axis > all),
 *  reading both scale and arbitrary at each level. */
export function boxSide(className: string, type: BoxType, side: Side): SpacingValue | null {
  const p = BOX_PREFIX[type];
  const axis = side === 'top' || side === 'bottom' ? `${p}y` : `${p}x`;
  return (
    spacingValue(className, `${p}${SIDE_LETTER[side]}`) ??
    spacingValue(className, axis) ??
    spacingValue(className, p)
  );
}

/** The CSS length a SpacingValue resolves to (drives the live-preview decl). */
export function spacingCss(v: SpacingValue): string {
  return v.kind === 'scale' ? `${v.n * SPACING_REM}rem` : v.raw;
}

/** What a value field displays: the scale integer, or the raw arbitrary value. */
export function spacingDisplay(v: SpacingValue | null): string {
  if (!v) return '0';
  return v.kind === 'scale' ? String(v.n) : v.raw;
}

/** The Tailwind utility prefix for one box side (`pt`, `ml`, …). */
export function boxSidePrefix(type: BoxType, side: Side): string {
  return `${BOX_PREFIX[type]}${SIDE_LETTER[side]}`;
}

/** Arbitrary-value class token, escaping spaces as Tailwind requires
 *  (`p`, `10rem` → `p-[10rem]`). */
export function arbitraryToken(prefix: string, value: string): string {
  return `${prefix}-[${value.trim().replace(/\s+/g, '_')}]`;
}

/** The class token for a SpacingValue at a utility prefix (`p-6` or `p-[10rem]`). */
export function spacingTokenFor(prefix: string, v: SpacingValue): string {
  return v.kind === 'scale' ? `${prefix}-${v.n}` : arbitraryToken(prefix, v.raw);
}

/** Whether the browser accepts `value` for `prop` — Webflow-grade unit validation
 *  (handles px/rem/em/%/vh/clamp()/calc()…). False in environments without CSS. */
function cssSupports(prop: string, value: string): boolean {
  try {
    return (
      typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports(prop, value)
    );
  } catch {
    return false;
  }
}

/** Classify typed input for a spacing field: a bare non-negative integer is a
 *  Tailwind scale step; anything else must be a valid CSS value for `cssProp`;
 *  otherwise invalid (the field flags a bad unit). */
export type ParsedSpacing = SpacingValue | { kind: 'invalid' };
export function parseSpacingInput(input: string, cssProp: string): ParsedSpacing {
  let s = input.trim();
  if (s === '') return { kind: 'invalid' };
  // Forgive a space between a number and its unit ("3 rem" → "3rem"); leave
  // function values (calc/clamp/min/max) untouched, where spaces are meaningful.
  s = s.replace(/^(-?\d*\.?\d+)\s+([a-z%]+)$/i, '$1$2');
  if (/^\d+$/.test(s)) return { kind: 'scale', n: Number(s) };
  return cssSupports(cssProp, s) ? { kind: 'arbitrary', raw: s } : { kind: 'invalid' };
}

/** Step a spacing value by `delta` units: scale steps the integer (clamped at 0);
 *  an arbitrary `<number><unit>` steps the number and keeps the unit; non-numeric
 *  arbitraries (e.g. `calc(…)`) are returned unchanged. */
export function stepSpacingValue(v: SpacingValue | null, delta: number): SpacingValue {
  if (!v || v.kind === 'scale') {
    return { kind: 'scale', n: Math.max(0, (v?.kind === 'scale' ? v.n : 0) + delta) };
  }
  const m = /^(-?\d*\.?\d+)(.*)$/.exec(v.raw.trim());
  if (!m) return v;
  const next = Math.max(0, parseFloat(m[1]) + delta);
  const num = Number.isInteger(next) ? String(next) : String(parseFloat(next.toFixed(3)));
  return { kind: 'arbitrary', raw: `${num}${m[2]}` };
}

/** One choice in an enum (segmented) control. `style` is a kebab-case inline
 *  patch for JIT-independent live preview, mirroring what the class resolves to. */
export interface EnumOption {
  label: string;
  token: string;
  style: Record<string, string>;
}

/** How an enum control is rendered. */
export type EnumVariant = 'segmented' | 'icons' | 'dropdown';

export interface EnumControl {
  label: string;
  variant: EnumVariant;
  options: EnumOption[];
}

/** Enum controls the panel renders. twMerge handles swapping the previously
 *  applied option (same Tailwind group); `style` drives JIT-independent preview. */
export const ENUM_CONTROLS: EnumControl[] = [
  {
    label: 'Align',
    variant: 'icons',
    options: [
      { label: 'Left', token: 'text-left', style: { 'text-align': 'left' } },
      { label: 'Center', token: 'text-center', style: { 'text-align': 'center' } },
      { label: 'Right', token: 'text-right', style: { 'text-align': 'right' } },
    ],
  },
  {
    label: 'Weight',
    variant: 'dropdown',
    options: [
      { label: 'Normal', token: 'font-normal', style: { 'font-weight': '400' } },
      { label: 'Medium', token: 'font-medium', style: { 'font-weight': '500' } },
      { label: 'Semibold', token: 'font-semibold', style: { 'font-weight': '600' } },
      { label: 'Bold', token: 'font-bold', style: { 'font-weight': '700' } },
    ],
  },
  {
    label: 'Size',
    variant: 'dropdown',
    options: [
      { label: 'XS', token: 'text-xs', style: { 'font-size': '0.75rem' } },
      { label: 'SM', token: 'text-sm', style: { 'font-size': '0.875rem' } },
      { label: 'Base', token: 'text-base', style: { 'font-size': '1rem' } },
      { label: 'LG', token: 'text-lg', style: { 'font-size': '1.125rem' } },
      { label: 'XL', token: 'text-xl', style: { 'font-size': '1.25rem' } },
      { label: '2XL', token: 'text-2xl', style: { 'font-size': '1.5rem' } },
      { label: '3XL', token: 'text-3xl', style: { 'font-size': '1.875rem' } },
      { label: '4XL', token: 'text-4xl', style: { 'font-size': '2.25rem' } },
      { label: '5XL', token: 'text-5xl', style: { 'font-size': '3rem' } },
    ],
  },
  {
    label: 'Radius',
    variant: 'dropdown',
    options: [
      { label: 'None', token: 'rounded-none', style: { 'border-radius': '0' } },
      { label: 'SM', token: 'rounded-sm', style: { 'border-radius': '0.125rem' } },
      { label: 'MD', token: 'rounded-md', style: { 'border-radius': '0.375rem' } },
      { label: 'LG', token: 'rounded-lg', style: { 'border-radius': '0.5rem' } },
      { label: 'XL', token: 'rounded-xl', style: { 'border-radius': '0.75rem' } },
      { label: '2XL', token: 'rounded-2xl', style: { 'border-radius': '1rem' } },
      { label: 'Full', token: 'rounded-full', style: { 'border-radius': '9999px' } },
    ],
  },
  {
    label: 'Display',
    variant: 'dropdown',
    options: [
      { label: 'Block', token: 'block', style: { display: 'block' } },
      { label: 'Flex', token: 'flex', style: { display: 'flex' } },
      { label: 'Grid', token: 'grid', style: { display: 'grid' } },
      { label: 'Inline block', token: 'inline-block', style: { display: 'inline-block' } },
      { label: 'Inline', token: 'inline', style: { display: 'inline' } },
      { label: 'Hidden', token: 'hidden', style: { display: 'none' } },
    ],
  },
  {
    label: 'Justify',
    variant: 'icons',
    options: [
      { label: 'Start', token: 'justify-start', style: { 'justify-content': 'flex-start' } },
      { label: 'Center', token: 'justify-center', style: { 'justify-content': 'center' } },
      { label: 'End', token: 'justify-end', style: { 'justify-content': 'flex-end' } },
      { label: 'Between', token: 'justify-between', style: { 'justify-content': 'space-between' } },
    ],
  },
  {
    label: 'Align items',
    variant: 'icons',
    options: [
      { label: 'Start', token: 'items-start', style: { 'align-items': 'flex-start' } },
      { label: 'Center', token: 'items-center', style: { 'align-items': 'center' } },
      { label: 'End', token: 'items-end', style: { 'align-items': 'flex-end' } },
      { label: 'Stretch', token: 'items-stretch', style: { 'align-items': 'stretch' } },
    ],
  },
  {
    label: 'Border',
    variant: 'dropdown',
    options: [
      { label: 'None', token: 'border-0', style: { 'border-width': '0' } },
      { label: '1px', token: 'border', style: { 'border-width': '1px', 'border-style': 'solid' } },
      {
        label: '2px',
        token: 'border-2',
        style: { 'border-width': '2px', 'border-style': 'solid' },
      },
      {
        label: '4px',
        token: 'border-4',
        style: { 'border-width': '4px', 'border-style': 'solid' },
      },
      {
        label: '8px',
        token: 'border-8',
        style: { 'border-width': '8px', 'border-style': 'solid' },
      },
    ],
  },
  {
    label: 'Position',
    variant: 'dropdown',
    options: [
      { label: 'Static', token: 'static', style: { position: 'static' } },
      { label: 'Relative', token: 'relative', style: { position: 'relative' } },
      { label: 'Absolute', token: 'absolute', style: { position: 'absolute' } },
      { label: 'Fixed', token: 'fixed', style: { position: 'fixed' } },
      { label: 'Sticky', token: 'sticky', style: { position: 'sticky' } },
    ],
  },
  {
    label: 'Direction',
    variant: 'dropdown',
    options: [
      { label: 'Row', token: 'flex-row', style: { 'flex-direction': 'row' } },
      {
        label: 'Row reverse',
        token: 'flex-row-reverse',
        style: { 'flex-direction': 'row-reverse' },
      },
      { label: 'Column', token: 'flex-col', style: { 'flex-direction': 'column' } },
      {
        label: 'Column reverse',
        token: 'flex-col-reverse',
        style: { 'flex-direction': 'column-reverse' },
      },
    ],
  },
  {
    label: 'Wrap',
    variant: 'dropdown',
    options: [
      { label: 'No wrap', token: 'flex-nowrap', style: { 'flex-wrap': 'nowrap' } },
      { label: 'Wrap', token: 'flex-wrap', style: { 'flex-wrap': 'wrap' } },
      { label: 'Wrap reverse', token: 'flex-wrap-reverse', style: { 'flex-wrap': 'wrap-reverse' } },
    ],
  },
  {
    label: 'Overflow',
    variant: 'dropdown',
    options: [
      { label: 'Visible', token: 'overflow-visible', style: { overflow: 'visible' } },
      { label: 'Auto', token: 'overflow-auto', style: { overflow: 'auto' } },
      { label: 'Hidden', token: 'overflow-hidden', style: { overflow: 'hidden' } },
      { label: 'Scroll', token: 'overflow-scroll', style: { overflow: 'scroll' } },
    ],
  },
  {
    label: 'Z-index',
    variant: 'dropdown',
    options: [
      { label: 'Auto', token: 'z-auto', style: { 'z-index': 'auto' } },
      { label: '0', token: 'z-0', style: { 'z-index': '0' } },
      { label: '10', token: 'z-10', style: { 'z-index': '10' } },
      { label: '20', token: 'z-20', style: { 'z-index': '20' } },
      { label: '30', token: 'z-30', style: { 'z-index': '30' } },
      { label: '40', token: 'z-40', style: { 'z-index': '40' } },
      { label: '50', token: 'z-50', style: { 'z-index': '50' } },
    ],
  },
  {
    label: 'Line height',
    variant: 'dropdown',
    options: [
      { label: 'None', token: 'leading-none', style: { 'line-height': '1' } },
      { label: 'Tight', token: 'leading-tight', style: { 'line-height': '1.25' } },
      { label: 'Snug', token: 'leading-snug', style: { 'line-height': '1.375' } },
      { label: 'Normal', token: 'leading-normal', style: { 'line-height': '1.5' } },
      { label: 'Relaxed', token: 'leading-relaxed', style: { 'line-height': '1.625' } },
      { label: 'Loose', token: 'leading-loose', style: { 'line-height': '2' } },
    ],
  },
  {
    label: 'Letter spacing',
    variant: 'dropdown',
    options: [
      { label: 'Tighter', token: 'tracking-tighter', style: { 'letter-spacing': '-0.05em' } },
      { label: 'Tight', token: 'tracking-tight', style: { 'letter-spacing': '-0.025em' } },
      { label: 'Normal', token: 'tracking-normal', style: { 'letter-spacing': '0em' } },
      { label: 'Wide', token: 'tracking-wide', style: { 'letter-spacing': '0.025em' } },
      { label: 'Wider', token: 'tracking-wider', style: { 'letter-spacing': '0.05em' } },
      { label: 'Widest', token: 'tracking-widest', style: { 'letter-spacing': '0.1em' } },
    ],
  },
  {
    label: 'Transform',
    variant: 'dropdown',
    options: [
      { label: 'None', token: 'normal-case', style: { 'text-transform': 'none' } },
      { label: 'Uppercase', token: 'uppercase', style: { 'text-transform': 'uppercase' } },
      { label: 'Lowercase', token: 'lowercase', style: { 'text-transform': 'lowercase' } },
      { label: 'Capitalize', token: 'capitalize', style: { 'text-transform': 'capitalize' } },
    ],
  },
  {
    label: 'Style',
    variant: 'dropdown',
    options: [
      { label: 'Normal', token: 'not-italic', style: { 'font-style': 'normal' } },
      { label: 'Italic', token: 'italic', style: { 'font-style': 'italic' } },
    ],
  },
  {
    label: 'Decoration',
    variant: 'dropdown',
    options: [
      { label: 'None', token: 'no-underline', style: { 'text-decoration-line': 'none' } },
      { label: 'Underline', token: 'underline', style: { 'text-decoration-line': 'underline' } },
      {
        label: 'Line through',
        token: 'line-through',
        style: { 'text-decoration-line': 'line-through' },
      },
    ],
  },
  {
    label: 'Shadow',
    variant: 'dropdown',
    options: [
      { label: 'None', token: 'shadow-none', style: { 'box-shadow': 'none' } },
      {
        label: 'SM',
        token: 'shadow-sm',
        style: { 'box-shadow': '0 1px 2px 0 rgb(0 0 0 / 0.05)' },
      },
      {
        label: 'MD',
        token: 'shadow',
        style: { 'box-shadow': '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)' },
      },
      {
        label: 'LG',
        token: 'shadow-md',
        style: { 'box-shadow': '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)' },
      },
      {
        label: 'XL',
        token: 'shadow-lg',
        style: {
          'box-shadow': '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
        },
      },
      {
        label: '2XL',
        token: 'shadow-xl',
        style: {
          'box-shadow': '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
        },
      },
      {
        label: '3XL',
        token: 'shadow-2xl',
        style: { 'box-shadow': '0 25px 50px -12px rgb(0 0 0 / 0.25)' },
      },
    ],
  },
  {
    label: 'Blur',
    variant: 'dropdown',
    options: [
      { label: 'None', token: 'blur-none', style: { filter: 'blur(0)' } },
      { label: 'SM', token: 'blur-sm', style: { filter: 'blur(4px)' } },
      { label: 'MD', token: 'blur', style: { filter: 'blur(8px)' } },
      { label: 'LG', token: 'blur-md', style: { filter: 'blur(12px)' } },
      { label: 'XL', token: 'blur-lg', style: { filter: 'blur(16px)' } },
      { label: '2XL', token: 'blur-xl', style: { filter: 'blur(24px)' } },
    ],
  },
  {
    label: 'Cursor',
    variant: 'dropdown',
    options: [
      { label: 'Auto', token: 'cursor-auto', style: { cursor: 'auto' } },
      { label: 'Default', token: 'cursor-default', style: { cursor: 'default' } },
      { label: 'Pointer', token: 'cursor-pointer', style: { cursor: 'pointer' } },
      { label: 'Text', token: 'cursor-text', style: { cursor: 'text' } },
      { label: 'Move', token: 'cursor-move', style: { cursor: 'move' } },
      { label: 'Wait', token: 'cursor-wait', style: { cursor: 'wait' } },
      { label: 'Not allowed', token: 'cursor-not-allowed', style: { cursor: 'not-allowed' } },
    ],
  },
];

/** Text / background color controls — arbitrary hex via a native color picker. */
export const COLOR_CONTROLS = [
  { label: 'Text', prefix: 'text', css: 'color' },
  { label: 'Background', prefix: 'bg', css: 'background-color' },
  { label: 'Border color', prefix: 'border', css: 'border-color' },
] as const;

export type ColorPrefix = (typeof COLOR_CONTROLS)[number]['prefix'];

/** Current arbitrary hex for a color utility (`text-[#fff]`), or null if absent
 *  / a named Tailwind color (which we can't map back to hex here). */
export function arbitraryColor(className: string, prefix: ColorPrefix): string | null {
  const m = new RegExp(`(?:^|\\s)${prefix}-\\[(#[0-9a-fA-F]{3,8})\\]`).exec(className);
  return m ? m[1] : null;
}

/** Class token for an arbitrary color, e.g. `text-[#1a1a1a]`. */
export function colorToken(prefix: ColorPrefix, hex: string): string {
  return `${prefix}-[${hex}]`;
}

/** Anything Tailwind would treat as an arbitrary color value (vs a length/var). */
const COLOR_VALUE = /^(#|rgb|hsl|hwb|oklch|oklab|lab|lch|color\(|var\()/i;

/**
 * The raw arbitrary color inside `<prefix>-[…]` (any format — hex, rgb(), hsl(),
 * oklch(), or a var()), with Tailwind's `_` un-escaped back to spaces. Returns
 * null when the bracket value isn't color-like (e.g. `text-[14px]`) or absent.
 */
export function arbitraryColorRaw(className: string, prefix: ColorPrefix): string | null {
  const m = new RegExp(`(?:^|\\s)${prefix}-\\[([^\\]]+)\\]`).exec(className);
  if (!m) return null;
  const raw = m[1].replace(/_/g, ' ');
  return COLOR_VALUE.test(raw) ? raw : null;
}

/** Build an arbitrary-color class from a CSS color, escaping spaces to `_` as
 *  Tailwind requires, e.g. `oklch(0.62 0.18 39)` → `text-[oklch(0.62_0.18_39)]`. */
export function colorClassToken(prefix: ColorPrefix, cssColor: string): string {
  return `${prefix}-[${cssColor.trim().replace(/\s+/g, '_')}]`;
}

/** Detect a CSS color string's format so edits can preserve it (match-existing). */
export function colorFormatOf(cssColor: string): 'hex' | 'rgb' | 'hsl' | 'oklch' {
  const s = cssColor.trim().toLowerCase();
  if (s.startsWith('oklch')) return 'oklch';
  if (s.startsWith('hsl')) return 'hsl';
  if (s.startsWith('rgb')) return 'rgb';
  return 'hex';
}

/** The token of the option currently active in `className` for a control, or null. */
export function activeEnumToken(className: string, control: EnumControl): string | null {
  const tokens = new Set(className.split(/\s+/));
  for (const option of control.options) {
    if (tokens.has(option.token)) return option.token;
  }
  return null;
}

// ───────────────────── Sizing (width / height / max-width / …) ───────────────
//
// A length control edits a sizing utility (`w`, `h`, `max-w`, `min-h`). Its value
// can be a named keyword (`full`, `screen`, `auto`), a fraction (`1/2`), a Tailwind
// scale step (`64`), or any arbitrary CSS length (`480px`, `clamp(…)` → `w-[…]`).

/** Named size keywords → the CSS they resolve to. `screen` depends on the axis
 *  (`w-screen` = 100vw, `h-screen` = 100vh), so it's a function of the prop. */
const LENGTH_KEYWORDS: Record<string, (axis: 'w' | 'h') => string> = {
  full: () => '100%',
  screen: (a) => (a === 'h' ? '100vh' : '100vw'),
  auto: () => 'auto',
  min: () => 'min-content',
  max: () => 'max-content',
  fit: () => 'fit-content',
  none: () => 'none',
};

/** Common presets a length field offers as autocomplete (still free-form). */
export const LENGTH_PRESETS = ['full', 'screen', 'auto', '1/2', '1/3', '2/3', '1/4', '3/4'];

/** Which axis a sizing prop sits on, so `screen`/etc. resolve correctly. */
function lengthAxis(css: string): 'w' | 'h' {
  return css.includes('height') ? 'h' : 'w';
}

/** The current value of a sizing utility as a display string (`full`, `1/2`,
 *  `64`, `480px`), or null when unset. Reads arbitrary first, then named/scale. */
export function lengthValue(className: string, prefix: string): string | null {
  const arb = arbitraryValue(className, prefix);
  if (arb !== null) return arb;
  const m = new RegExp(`(?:^|\\s)${prefix}-([\\w./%-]+)`).exec(className);
  return m ? m[1] : null;
}

/** Parse a typed length value into a Tailwind token + its preview CSS. Accepts a
 *  keyword, a fraction, a bare scale integer, or an arbitrary CSS length; anything
 *  else (a bad unit) is invalid. */
export type ParsedLength = { kind: 'ok'; token: string; css: string } | { kind: 'invalid' };
export function parseLengthInput(input: string, prefix: string, css: string): ParsedLength {
  let s = input.trim();
  if (s === '') return { kind: 'invalid' };
  const axis = lengthAxis(css);
  const kw = LENGTH_KEYWORDS[s.toLowerCase()];
  if (kw) return { kind: 'ok', token: `${prefix}-${s.toLowerCase()}`, css: kw(axis) };
  const frac = /^(\d+)\/(\d+)$/.exec(s);
  if (frac) {
    const pct = (Number(frac[1]) / Number(frac[2])) * 100;
    return { kind: 'ok', token: `${prefix}-${s}`, css: `${Number(pct.toFixed(4))}%` };
  }
  // Forgive a space between number and unit ("3 rem" → "3rem").
  s = s.replace(/^(-?\d*\.?\d+)\s+([a-z%]+)$/i, '$1$2');
  if (/^\d+$/.test(s)) {
    return { kind: 'ok', token: `${prefix}-${s}`, css: `${Number(s) * SPACING_REM}rem` };
  }
  return cssSupports(css, s)
    ? { kind: 'ok', token: arbitraryToken(prefix, s), css: s }
    : { kind: 'invalid' };
}

/** Reset spec for a sizing utility — removes any token for this prefix at the
 *  active layer (`w-full`, `w-64`, `w-[…]`) and neutralizes its CSS. */
export function lengthResetSpec(prefix: string, css: string): ResetSpec {
  return { match: (t) => t === prefix || t.startsWith(`${prefix}-`), cssProps: [css] };
}

// ───────────────────── Custom CSS (arbitrary properties) ─────────────────────
//
// Tailwind's native escape hatch for any CSS property is the arbitrary *property*
// `[prop:value]` (e.g. `[mask-type:luminance]`). The custom box types `prop: value`
// and emits a real Tailwind class — spaces in the value escaped to `_`.

export interface ArbitraryProp {
  prop: string;
  value: string;
  /** The bare (unprefixed) Tailwind token, e.g. `[clip-path:circle(50%)]`. */
  token: string;
}

/** Build an arbitrary-property token from a CSS prop + value (`clip-path`,
 *  `circle(50%)` → `[clip-path:circle(50%)]`), escaping spaces as Tailwind needs. */
export function arbitraryPropToken(prop: string, value: string): string {
  return `[${prop.trim()}:${value.trim().replace(/\s+/g, '_')}]`;
}

/** Parse a typed `prop: value` (or `prop:value`) line into a validated arbitrary
 *  property, or null when the property/value isn't real CSS. */
export function parseArbitraryProp(input: string): ArbitraryProp | null {
  const i = input.indexOf(':');
  if (i < 0) return null;
  const prop = input.slice(0, i).trim().toLowerCase();
  const value = input.slice(i + 1).trim();
  if (!/^-{0,2}[a-z][a-z0-9-]*$/.test(prop) || value === '') return null;
  if (!cssSupports(prop, value)) return null;
  return { prop, value, token: arbitraryPropToken(prop, value) };
}

/** Every arbitrary-property token in a (variant-scoped) class string, decoded back
 *  to `{prop, value}` for display in the custom-CSS list. */
export function listArbitraryProps(className: string): ArbitraryProp[] {
  const out: ArbitraryProp[] = [];
  const re = /(?:^|\s)(\[([a-z-]+):([^\]]+)\])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(className)) !== null) {
    out.push({ token: m[1], prop: m[2], value: m[3].replace(/_/g, ' ') });
  }
  return out;
}

// ───────────────── Winning the cascade against custom CSS ────────────────────
//
// Tailwind utilities live in the `utilities` cascade layer. CSS a site writes
// OUTSIDE any `@layer` (plain `.hero-headline { color }`) beats *all* layered
// styles regardless of specificity. So when an element's property is set by such
// an unlayered rule, a plain utility we add loses — the saved edit doesn't show
// even though the `!important` live preview did. The fix: mark just those edits
// with Tailwind's important modifier so they win. We append `!` (Tailwind v4
// syntax, e.g. `text-[#fff]!`); v3 projects would need a leading `!` instead.

/** Map an edited longhand to the shorthand(s) that could set it in custom CSS, so
 *  `padding: 0` (shorthand) is recognized as competing with a `padding-top` edit. */
const SHORTHAND_ROOTS: Record<string, string[]> = {
  'padding-top': ['padding'],
  'padding-right': ['padding'],
  'padding-bottom': ['padding'],
  'padding-left': ['padding'],
  'margin-top': ['margin'],
  'margin-right': ['margin'],
  'margin-bottom': ['margin'],
  'margin-left': ['margin'],
  'background-color': ['background'],
  'border-color': ['border'],
  'border-width': ['border'],
  'font-size': ['font'],
  'font-weight': ['font'],
  'font-style': ['font'],
  'line-height': ['font'],
  'text-decoration-line': ['text-decoration'],
};

/** Whether any of the CSS properties an edit sets is controlled by an unlayered
 *  rule (so a plain utility would lose the cascade and the edit needs `!`). */
export function competesWithUnlayered(cssProps: string[], unlayered?: string[]): boolean {
  if (!unlayered || unlayered.length === 0) return false;
  const set = new Set(unlayered);
  return cssProps.some(
    (p) => set.has(p) || (SHORTHAND_ROOTS[p]?.some((root) => set.has(root)) ?? false)
  );
}

/** Add Tailwind's important modifier to a bare utility token (`p-8` → `p-8!`),
 *  idempotently. Applied before any variant prefix, so `withVariant` yields
 *  `md:p-8!` (v4 places `!` at the end). */
export function markImportant(token: string): string {
  return token.endsWith('!') ? token : `${token}!`;
}

/**
 * Surgically replace one className literal's value in source. `oldClass` is the
 * drift baseline — the backend rejects the edit if the file no longer matches.
 */
export function applyClassnameEdit(
  projectPath: string,
  file: string,
  line: number,
  oldClass: string,
  newClass: string
): Promise<void> {
  return invoke<void>('apply_classname_edit', {
    projectPath,
    file,
    line,
    oldClass,
    newClass,
  });
}

/** Apply the same className edit to several source locations at once ("edit all
 *  occurrences"). Stale spots are skipped; resolves with the count updated. */
export function applyClassnameEditMulti(
  projectPath: string,
  edits: SourceLocation[],
  oldClass: string,
  newClass: string
): Promise<number> {
  return invoke<number>('apply_classname_edit_multi', {
    projectPath,
    edits,
    oldClass,
    newClass,
  });
}

/** How a source file renders: a route page, a layout (wraps many pages), or a
 *  reusable component. */
export type FileKind = 'page' | 'layout' | 'component';

/** One place a component is rendered in source. */
export interface UsageSite {
  file: string;
  line: number;
  kind: FileKind;
}

/** Where the component containing an edited element is used across the project —
 *  the "this also appears in N places" scope hint. */
export interface UsageReport {
  /** Enclosing component name, if we could determine it. */
  component: string | null;
  /** Kind of the edited file itself (page = only this page; layout = every page). */
  selfKind: FileKind;
  /** Every `<Component>` render site found in source. */
  sites: UsageSite[];
}

/** Find where the component containing `file:line` is rendered project-wide. */
export function findComponentUsage(
  projectPath: string,
  file: string,
  line: number
): Promise<UsageReport> {
  return invoke<UsageReport>('find_component_usage', { projectPath, file, line });
}
