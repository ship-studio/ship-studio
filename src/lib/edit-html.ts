/**
 * Element HTML editing — resolve a selected element to its source markup span
 * and write edited markup back. Backend: `resolve_element_html` /
 * `apply_element_html` in `src-tauri/src/commands/edit.rs`.
 */

import { invoke } from '@tauri-apps/api/core';
import type { ElementSignature, SourceLocation } from './edit';

/** The selected element's source markup and where it lives. */
export interface ElementHtml {
  file: string;
  line: number;
  /** The element's source HTML: opening tag through its matching close tag. */
  html: string;
  /** Exact source span/hash for a single resolved instance. */
  sourceStart?: number;
  sourceEnd?: number;
  sourceHash?: string;
  sourceLine?: number;
  sourceColumn?: number;
  /** Present when the element's class string resolves to several identical
   *  source spots with byte-identical markup: every candidate location.
   *  General markup edits apply to all by default; image attribute edits refuse
   *  ambiguity unless a single source location is explicitly targeted. */
  locations?: SourceLocation[];
}

/** Exact image source location kept fresh across consecutive markup writes. */
export interface ElementSourceAnchor {
  file: string;
  sourceStart: number;
  sourceHash: string;
}

export interface ElementHtmlApplyResult {
  updated: number;
  sourceAnchor: ElementSourceAnchor | null;
}

/** Resolve a clicked element to its source HTML. Pass `location` (one of the
 *  resolved `locations`) to target a single instance of a multi-sourced element. */
export function resolveElementHtml(
  projectPath: string,
  signature: ElementSignature,
  location?: SourceLocation
): Promise<ElementHtml> {
  return invoke<ElementHtml>('resolve_element_html', { projectPath, signature, location });
}

/** Replace an element's source markup, verifying it still equals `oldHtml`.
 *  A multi-sourced element writes to every instance — or just `location`, if
 *  given. Image markup writes refuse ambiguity and spreads. Resolves with how
 *  many instances were updated. */
export function applyElementHtml(
  projectPath: string,
  signature: ElementSignature,
  oldHtml: string,
  newHtml: string,
  location?: SourceLocation,
  sourceAnchor?: ElementSourceAnchor
): Promise<ElementHtmlApplyResult> {
  return invoke<ElementHtmlApplyResult>('apply_element_html', {
    projectPath,
    signature,
    oldHtml,
    newHtml,
    location,
    sourceAnchor,
  });
}
