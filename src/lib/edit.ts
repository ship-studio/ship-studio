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
  | { status: 'ambiguous'; reason: string; candidate_count: number }
  | { status: 'read_only'; reason: string };

/** Resolve a clicked element to its source `className` location. */
export function resolveClassnameSource(
  projectPath: string,
  signature: ElementSignature
): Promise<Resolution> {
  return invoke<Resolution>('resolve_classname_source', { projectPath, signature });
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
];

/** Text / background color controls — arbitrary hex via a native color picker. */
export const COLOR_CONTROLS = [
  { label: 'Text', prefix: 'text', css: 'color' },
  { label: 'Background', prefix: 'bg', css: 'background-color' },
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
