/**
 * Visual editor — CSS Mode bindings (class-based CSS rule editing for
 * HTML/CSS-style projects, e.g. vanilla Astro). Wraps the Rust engine in
 * `src-tauri/src/commands/edit_css.rs`.
 *
 * This is a SEPARATE feature from the Tailwind visual editor (`lib/edit.ts`):
 * same selection/preview experience, but a style change here edits a CSS rule
 * (`padding: 24px`, any property/value) instead of a Tailwind utility token.
 */

import { invoke } from '@tauri-apps/api/core';
import type { ElementSignature } from './edit';

/** One CSS declaration on a rule (mirrors the Rust `Declaration`). */
export interface CssDeclaration {
  property: string;
  value: string;
  important: boolean;
}

/** A source location (shared shape with the Tailwind resolver). */
export interface CssLocation {
  file: string;
  line: number;
  column: number;
}

/** Outcome of resolving an element to its CSS rule (mirrors the Rust enum,
 *  `#[serde(tag = "status", rename_all = "snake_case")]`). */
export type CssResolution =
  | {
      status: 'resolved';
      /** Project-relative POSIX stylesheet path. */
      file: string;
      /** The class selector resolved, e.g. `.hero-title`. */
      selector: string;
      line: number;
      /** `min-width` of the enclosing `@media`, or null for the base layer. */
      media_min_px: number | null;
      declarations: CssDeclaration[];
    }
  | { status: 'multiple'; selector: string; locations: CssLocation[] }
  | { status: 'inline'; reason: string }
  | { status: 'needs_class'; reason: string }
  | { status: 'not_found'; selector: string }
  /** Frontend-only: the resolve command itself failed (IO/backend error). Kept
   *  distinct from `not_found` so we never offer "create rule" on a real error. */
  | { status: 'error'; reason: string };

/** Element signature for CSS resolution. Built from the in-iframe selection
 *  script's payload (`ElementSignature`); camelCase to match the Rust command. */
export interface CssSignature {
  className: string;
  tagName: string;
  /** Which class token to edit (defaults backend-side to the last token). */
  targetClass?: string;
  /** Whether the element carries an inline `style=""` (drives the Inline state). */
  hasInlineStyle?: boolean;
  /** Pseudo-class / state to target (without colon, e.g. "hover"). Resolves
   *  `.class:hover` — states are selectors in CSS. */
  pseudo?: string;
}

/** Build a `CssSignature` from the iframe selection signature. */
export function toCssSignature(
  sig: ElementSignature,
  targetClass?: string | null,
  pseudo?: string | null
): CssSignature {
  return {
    className: sig.className,
    tagName: sig.tagName,
    targetClass: targetClass ?? undefined,
    pseudo: pseudo ?? undefined,
  };
}

/** Resolve a clicked element to the CSS rule that styles its class. */
export function resolveCssRule(
  projectPath: string,
  signature: CssSignature,
  breakpointMinPx?: number | null
): Promise<CssResolution> {
  return invoke<CssResolution>('resolve_css_rule', {
    projectPath,
    signature,
    breakpointMinPx: breakpointMinPx ?? null,
  });
}

/** Surgically set (or remove, when `value` is null) one declaration on the rule
 *  for `selector`. Fail-closed if the rule can't be pinned to one block. */
export function setCssDeclaration(
  projectPath: string,
  file: string,
  selector: string,
  property: string,
  value: string | null,
  breakpointMinPx?: number | null
): Promise<void> {
  return invoke<void>('set_css_declaration', {
    projectPath,
    file,
    selector,
    breakpointMinPx: breakpointMinPx ?? null,
    property,
    value,
  });
}

/** Add a new custom property to the base `:root` scope, reusing an existing rule. */
export function addCssVariable(
  projectPath: string,
  file: string,
  property: string,
  value: string
): Promise<void> {
  return invoke<void>('add_css_variable', { projectPath, file, property, value });
}

/** Update one existing custom-property definition, pinned to its source rule. */
export function setCssVariable(
  projectPath: string,
  file: string,
  selector: string,
  line: number,
  property: string,
  value: string
): Promise<void> {
  return invoke<void>('set_css_variable', {
    projectPath,
    file,
    selector,
    line,
    property,
    value,
  });
}

export interface CssVariableDeleteImpact {
  usageCount: number;
  ruleCount: number;
  fileCount: number;
  definitionCount: number;
  replacementValue: string;
}

/** Inspect the authored impact of inlining and removing a project CSS variable. */
export function analyzeCssVariableDeletion(
  projectPath: string,
  property: string,
  replacementValue: string
): Promise<CssVariableDeleteImpact> {
  return invoke<CssVariableDeleteImpact>('analyze_css_variable_deletion', {
    projectPath,
    property,
    replacementValue,
  });
}

/** Inline a variable's raw value everywhere and remove all of its definitions. */
export function deleteCssVariable(
  projectPath: string,
  property: string,
  replacementValue: string,
  impact: Pick<CssVariableDeleteImpact, 'usageCount' | 'definitionCount'>
): Promise<CssVariableDeleteImpact> {
  return invoke<CssVariableDeleteImpact>('delete_css_variable', {
    projectPath,
    property,
    replacementValue,
    expectedUsageCount: impact.usageCount,
    expectedDefinitionCount: impact.definitionCount,
  });
}

/** Append a new rule for `selector` to the authored stylesheet `file`. */
export function createCssClass(
  projectPath: string,
  file: string,
  selector: string,
  declarations: CssDeclaration[],
  breakpointMinPx?: number | null
): Promise<void> {
  return invoke<void>('create_css_class', {
    projectPath,
    file,
    selector,
    declarations,
    breakpointMinPx: breakpointMinPx ?? null,
  });
}

/** List hand-authored stylesheets (project-relative POSIX paths). */
export function listStylesheets(projectPath: string): Promise<string[]> {
  return invoke<string[]>('list_stylesheets', { projectPath });
}

/** Every class name defined across the project's stylesheets (for the class
 *  bar's search-and-create combobox). */
export function listCssClasses(projectPath: string): Promise<string[]> {
  return invoke<string[]>('list_css_classes', { projectPath });
}

/**
 * Build a ready-to-paste agent request that refactors a project toward the
 * conventions the CSS visual editor relies on. This is the on-ramp for projects
 * that don't conform yet (inline styles, utility soup, a class defined by
 * several rules) — the user reviews it, then hands it to their coding agent.
 *
 * `authoredSheets` seeds the agent with the real stylesheet paths when known;
 * the prompt is deliberately design-preserving (refactor structure, not looks).
 */
export function buildCssPrepPrompt(authoredSheets: string[] = []): string {
  const sheetLine =
    authoredSheets.length > 0
      ? `\nStylesheets in this project: ${authoredSheets.join(', ')}. Prefer consolidating into a single primary stylesheet.`
      : '';
  return (
    `Refactor this project's styling so it can be edited with a visual, click-to-edit CSS editor. ` +
    `Do NOT change how the site looks — this is a structural refactor only.${sheetLine}\n\n` +
    `Apply these conventions:\n` +
    `1. Style through CSS classes, not inline style="" attributes. Move any inline styles onto classes.\n` +
    `2. Keep styles in the external stylesheets the pages link — not inline <style> blocks or CSS-in-JS.\n` +
    `3. Elements may carry MULTIPLE classes — base + modifier/combo classes (e.g. BEM, "card card--active") is perfectly fine. Just make sure each class is defined by a SINGLE rule: if the same class is defined by several scattered rules, consolidate its declarations into one.\n` +
    `4. Give classes meaningful names for what they style.\n` +
    `5. Keep responsive overrides in @media blocks (min-width / max-width), each mirroring the base rule's selector.\n\n` +
    `Work file by file, keep the rendered output visually identical, and tell me which files you changed when done.`
  );
}
