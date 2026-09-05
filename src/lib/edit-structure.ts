/**
 * Structural element editing — insert / duplicate / delete / paste elements on the
 * canvas, committed straight to source. Backend: `insert_element` /
 * `duplicate_element` / `paste_element` / `delete_element` in
 * `src-tauri/src/commands/edit_structure.rs`.
 */

import { invoke } from '@tauri-apps/api/core';
import type { ElementSignature } from './edit';

/** Where a new element lands relative to the selected anchor. */
export type InsertPosition = 'before' | 'after' | 'inside';

export type ElementKind =
  | 'div'
  | 'section'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'p'
  | 'a'
  | 'button'
  | 'img'
  | 'ul'
  | 'span';

/** The committed element, echoed back for the post-reload reselect. */
export interface InsertedElement {
  file: string;
  line: number;
  /** The new element's full class attribute value — the reselect signature's key. */
  className: string;
  tagName: string;
}

/**
 * The insert palette — mirrors the template table in `edit_structure.rs`.
 * `text` is each template's placeholder text: it goes into the reselect
 * signature so `findBySignature` scores the freshly-rendered element.
 */
export const ELEMENT_KINDS: { kind: ElementKind; label: string; text: string }[] = [
  { kind: 'div', label: 'Div', text: '' },
  { kind: 'section', label: 'Section', text: '' },
  { kind: 'h1', label: 'Heading 1', text: 'Heading' },
  { kind: 'h2', label: 'Heading 2', text: 'Heading' },
  { kind: 'h3', label: 'Heading 3', text: 'Heading' },
  { kind: 'p', label: 'Paragraph', text: 'Write something here.' },
  { kind: 'a', label: 'Link', text: 'Link' },
  { kind: 'button', label: 'Button', text: 'Button' },
  { kind: 'img', label: 'Image', text: '' },
  { kind: 'ul', label: 'List', text: 'List item' },
  { kind: 'span', label: 'Text span', text: 'Text' },
];

/** Tags that can't contain children — mirrors `VOID_ELEMENTS` in `edit.rs`.
 *  Gates the "Inside" insert position in the UI. */
export const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/** Tags that ARE the document — mirrors `STRUCTURAL_TAGS` in `edit_structure.rs`.
 *  Deleting, duplicating, or inserting beside one would break the page, so the
 *  backend refuses; the UI disables those actions rather than round-tripping to
 *  a refusal (issues #723/#740). */
export const STRUCTURAL_ELEMENTS = new Set(['html', 'head', 'body']);

/** Insert a new `elementKind` before/after/inside the selected element. */
export function insertElement(
  projectPath: string,
  signature: ElementSignature,
  position: InsertPosition,
  elementKind: ElementKind
): Promise<InsertedElement> {
  return invoke<InsertedElement>('insert_element', {
    projectPath,
    signature,
    position,
    elementKind,
  });
}

/** Duplicate the selected element right after itself. */
export function duplicateElement(
  projectPath: string,
  signature: ElementSignature
): Promise<InsertedElement> {
  return invoke<InsertedElement>('duplicate_element', { projectPath, signature });
}

/** Paste a captured element subtree inside the selected element. */
export function pasteElement(
  projectPath: string,
  signature: ElementSignature,
  html: string,
  sourceClassName: string
): Promise<InsertedElement> {
  return invoke<InsertedElement>('paste_element', {
    projectPath,
    signature,
    html,
    sourceClassName,
  });
}

/** Delete the selected element's markup, drift-guarded against `oldHtml`. */
export function deleteElement(
  projectPath: string,
  signature: ElementSignature,
  oldHtml: string
): Promise<void> {
  return invoke<void>('delete_element', { projectPath, signature, oldHtml });
}
