/**
 * Custom classes — frontend bindings for the Webflow-style custom-class backend
 * (`src-tauri/src/commands/custom_classes.rs`).
 *
 * A custom class is a named rule in the project's entry stylesheet, composed
 * from the same Tailwind tokens the editor's controls emit:
 *
 *   @layer components { .btn-primary { @apply px-4 py-2 rounded; } }
 *
 * Editing the rule's `@apply` list updates every element carrying the class.
 * Phase 0 exposes detection + read-only listing only.
 */

import { invoke } from '@tauri-apps/api/core';

/** Which Tailwind generation the project uses (`none` = no recognizable setup). */
export type TailwindVersion = 'v3' | 'v4' | 'none';

/** Where and how custom classes can be managed in this project. */
export interface TailwindSetup {
  version: TailwindVersion;
  /** POSIX-relative path to the Tailwind-importing stylesheet, or null if none
   *  could be located (custom classes need this file to compile `@apply`). */
  entryCss: string | null;
  /** Whether `entryCss` already has a writable `@layer components { … }` block. */
  componentsLayer: boolean;
}

/** One custom class parsed from the entry stylesheet. */
export interface CustomClass {
  /** Class name without the leading dot (e.g. `btn-primary`). */
  name: string;
  /** Utility tokens in its `@apply` list, in source order. */
  tokens: string[];
  /** True when the rule is a pure `@apply` list we can safely round-trip; false
   *  when it mixes raw declarations or nested rules. */
  editable: boolean;
}

/** Detect the project's Tailwind generation and locate its entry stylesheet. */
export function detectTailwindSetup(projectPath: string): Promise<TailwindSetup> {
  return invoke<TailwindSetup>('detect_tailwind_setup', { projectPath });
}

/** List the custom classes defined in the project's entry stylesheet (read-only). */
export function listCustomClasses(projectPath: string): Promise<CustomClass[]> {
  return invoke<CustomClass[]>('list_custom_classes', { projectPath });
}

/**
 * Create a new custom class from Tailwind tokens (written as `@apply` into the
 * entry stylesheet's `@layer components`). Rejects bad names, bad tokens,
 * duplicates, or a project with no Tailwind entry stylesheet. Resolves to the
 * project's updated class list.
 */
export function createCustomClass(
  projectPath: string,
  name: string,
  tokens: string[]
): Promise<CustomClass[]> {
  return invoke<CustomClass[]>('create_custom_class', { projectPath, name, tokens });
}

/**
 * Replace a custom class's `@apply` token list — updating every element that
 * carries the class. Rejects a missing class or one mixing raw declarations the
 * editor can't safely rewrite. Resolves to the updated class list.
 */
export function updateCustomClass(
  projectPath: string,
  name: string,
  tokens: string[]
): Promise<CustomClass[]> {
  return invoke<CustomClass[]>('update_custom_class', { projectPath, name, tokens });
}

/**
 * Remove a custom class rule from the entry stylesheet. Markup still referencing
 * the class is left untouched (the caller should warn). Resolves to the updated
 * class list.
 */
export function deleteCustomClass(projectPath: string, name: string): Promise<CustomClass[]> {
  return invoke<CustomClass[]>('delete_custom_class', { projectPath, name });
}

/**
 * Of `tokens`, return the ones that can't safely go in an `@apply` (plain custom
 * classes defined in the project's CSS, not Tailwind utilities). "Create from
 * styles" uses this to keep those tokens on the element instead of breaking the
 * Tailwind build.
 */
export function classifyApplyTokens(projectPath: string, tokens: string[]): Promise<string[]> {
  return invoke<string[]>('classify_apply_tokens', { projectPath, tokens });
}
