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

/** One choice in an enum (segmented) control. `style` is a kebab-case inline
 *  patch for JIT-independent live preview, mirroring what the class resolves to. */
export interface EnumOption {
  label: string;
  token: string;
  style: Record<string, string>;
}

export interface EnumControl {
  label: string;
  options: EnumOption[];
}

/** Enum controls the panel renders as segmented buttons. twMerge handles
 *  swapping the previously-applied option (same Tailwind group). */
export const ENUM_CONTROLS: EnumControl[] = [
  {
    label: 'Align',
    options: [
      { label: 'Left', token: 'text-left', style: { 'text-align': 'left' } },
      { label: 'Center', token: 'text-center', style: { 'text-align': 'center' } },
      { label: 'Right', token: 'text-right', style: { 'text-align': 'right' } },
    ],
  },
  {
    label: 'Weight',
    options: [
      { label: 'Normal', token: 'font-normal', style: { 'font-weight': '400' } },
      { label: 'Medium', token: 'font-medium', style: { 'font-weight': '500' } },
      { label: 'Semibold', token: 'font-semibold', style: { 'font-weight': '600' } },
      { label: 'Bold', token: 'font-bold', style: { 'font-weight': '700' } },
    ],
  },
];

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
