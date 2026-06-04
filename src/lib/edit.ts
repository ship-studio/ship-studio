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

/** Current `p-N` value in a class string, or null if none / arbitrary (`p-[..]`). */
export function paddingValue(className: string): number | null {
  for (const token of className.split(/\s+/)) {
    const m = /^p-(\d+)$/.exec(token);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * The `p-N` token one integer step up/down from the class's current padding,
 * clamped at 0. Plain integer stepping (no sparse scale) — Tailwind v4 generates
 * spacing dynamically so every integer is valid, and the common v3 range (0–12)
 * is contiguous too. This avoids the surprising skips (e.g. 8 → 10) a hardcoded
 * scale produced.
 */
export function steppedPadding(className: string, dir: 1 | -1): string {
  const next = Math.max(0, (paddingValue(className) ?? 0) + dir);
  return `p-${next}`;
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
