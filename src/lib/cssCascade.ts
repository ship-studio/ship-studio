/**
 * Code-first CSS editor bindings (vanilla-CSS projects). A clicked element's full
 * cascade — every author rule that matches it, in cascade order, with each
 * declaration flagged active/overridden — is computed in the preview iframe
 * (`select_script.html`, `ss:cascade`); here we join those matches to their source
 * locations (`locate_css_rules`) and write edited rule bodies back verbatim
 * (`apply_css_rule_text`) over `src-tauri/src/commands/edit_css.rs`.
 *
 * This is the successor to the structured CSS-Mode editor (`lib/edit-css.ts`):
 * same selection experience, but the edit surface is the real `.css` source, not
 * property controls. See `docs/visual-editor-css-mode.md`.
 */

import { invoke } from '@tauri-apps/api/core';
import { asCommandError } from './errors';

/** One declaration of a matched rule, as the iframe cascade walker reports it. */
export interface CascadeDecl {
  prop: string;
  value: string;
  important: boolean;
  /** False when a higher-priority rule overrides this property (struck through). */
  active: boolean;
  /** When overridden, the selector of the rule that wins this property. */
  overriddenBy?: string;
}

/** A rule matching the clicked element, reported by the `ss:cascade` walker. */
export interface MatchedRule {
  /** The matched compound selector, or null for the element's inline `style=""`. */
  selector: string | null;
  declarations: CascadeDecl[];
  /** Approximate (ids, classes, types) specificity. */
  specificity: [number, number, number];
  sourceOrder: number;
  /** The enclosing `@media` condition text, if any (for display). */
  mediaText: string | null;
  /** The enclosing `@media (min-width: …)` value, if any. */
  mediaMinPx: number | null;
  /** The rule's media query doesn't currently match the viewport (greyed out). */
  inactiveMedia: boolean;
  /** The `@layer` name the rule lives in, if any. */
  layer: string | null;
  /** The enclosing `@container` condition, if any. */
  container?: string | null;
  /** The enclosing `@supports` condition, if any. */
  supports?: string | null;
  /** The served stylesheet URL (`parentStyleSheet.href`), or null for `<style>`. */
  href: string | null;
  origin: 'author' | 'inline';
}

/** Where a matched rule lives in source (mirrors the Rust `RuleLocation`,
 *  `#[serde(tag = "status", rename_all = "snake_case")]`). */
export type RuleLocation =
  | { status: 'resolved'; file: string; line: number; inner_text: string }
  | { status: 'multiple'; files: string[] }
  | { status: 'not_found' };

/** A query sent to `locate_css_rules` (camelCase to match the Rust command). */
export interface MatchedRuleQuery {
  selector: string;
  /** The enclosing media condition text (e.g. `(max-width: 768px)`), or null for base. */
  mediaText: string | null;
  href: string | null;
  /** The enclosing `@layer` name, or null — disambiguates the same selector across layers. */
  layer?: string | null;
  /** The enclosing `@container` condition, or null — disambiguates same-selector containers. */
  container?: string | null;
  /** The enclosing `@supports` condition, or null — disambiguates same-selector supports. */
  supports?: string | null;
}

/** A matched rule joined with its source provenance — the panel's row model. */
export interface CascadeRow {
  /** Index into the original `ss:cascade` list (stable preview/React key seed). */
  index: number;
  selector: string | null;
  declarations: CascadeDecl[];
  specificity: [number, number, number];
  /** The rule's position in the cascade walk — lets the iframe pin THE rule to live-preview
   *  or delete even when the same selector occurs in several rules (base + `@layer`, …). */
  sourceOrder?: number;
  mediaText: string | null;
  mediaMinPx: number | null;
  inactiveMedia: boolean;
  layer: string | null;
  /** The enclosing `@container` condition, if any (shown as a context chip). */
  container?: string | null;
  /** The enclosing `@supports` condition, if any (shown as a context chip). */
  supports?: string | null;
  origin: 'author' | 'inline';
  /** Whether this rule maps to a single editable source rule. */
  editable: boolean;
  /** Provenance + the verbatim source body (the editor's seed) when resolved. */
  file?: string;
  line?: number;
  innerText?: string;
  /** Candidate source files when the selector maps to more than one rule. */
  sourceFiles?: string[];
  /** Why a rule is read-only, surfaced in the UI. */
  readonlyReason?: string;
  /** A not-yet-created rule for one of the element's own selectors — an empty editable
   *  card shown in cascade order; the rule is written to source on the first property. */
  draft?: boolean;
  /** A locally-created rule whose selector doesn't actually match the selected element
   *  (e.g. you typed `cool` for an `<h1>`). It's pinned so it doesn't vanish, but it
   *  isn't part of this element's cascade — the card says so rather than implying it applies. */
  unmatched?: boolean;
}

/** Map a batch of cascade matches to their source locations (index-aligned). */
export function locateCssRules(
  projectPath: string,
  matched: MatchedRuleQuery[]
): Promise<RuleLocation[]> {
  return invoke<RuleLocation[]>('locate_css_rules', { projectPath, matched });
}

/** Write an edited rule body back to source, drift-guarded against `oldInner`. */
export function applyCssRuleText(
  projectPath: string,
  file: string,
  selector: string,
  mediaText: string | null,
  oldInner: string,
  newInner: string
): Promise<void> {
  return invoke<void>('apply_css_rule_text', {
    projectPath,
    file,
    selector,
    mediaText,
    oldInner,
    newInner,
  });
}

/** Create a new (empty) rule for `selector` in `file`, optionally wrapped in an
 *  at-rule condition (`@media (max-width: …)`, `@container …`, `@supports …`). */
export function createCssRule(
  projectPath: string,
  file: string,
  selector: string,
  atPrelude?: string | null
): Promise<void> {
  return invoke<void>('create_css_class', {
    projectPath,
    file,
    selector,
    declarations: [],
    breakpointMinPx: null,
    atPrelude: atPrelude ?? null,
  });
}

/** Hand-authored stylesheets in the project (project-relative POSIX paths). */
export function listStylesheets(projectPath: string): Promise<string[]> {
  return invoke<string[]>('list_stylesheets', { projectPath });
}

/** Every class name defined across the project's stylesheets (selector autocomplete). */
export function listCssClasses(projectPath: string): Promise<string[]> {
  return invoke<string[]>('list_css_classes', { projectPath });
}

/** Every existing rule selector (full text — `.card`, `@keyframes reveal`), for the
 *  "Add selector" autocomplete: discover what's defined and re-surface it on a match. */
export function listCssSelectors(projectPath: string): Promise<string[]> {
  return invoke<string[]>('list_css_selectors', { projectPath });
}

/** Every CSS custom-property name (`--foo`) defined in the project (value autocomplete). */
export function listCssVariables(projectPath: string): Promise<string[]> {
  return invoke<string[]>('list_css_variables', { projectPath });
}

/** A custom-property definition with where it's set — backs the Variables editor. */
export interface CssVariableDef {
  /** Name including the leading `--`. */
  name: string;
  value: string;
  /** The selector it's defined on (`:root`, `.theme-dark`, …). */
  selector: string;
  /** Project-relative stylesheet path. */
  file: string;
  /** One-based selector line, used to pin edits to this exact definition. */
  line: number;
}

/** Every custom-property definition in the project (name, value, scope, file). */
export function getCssVariables(projectPath: string): Promise<CssVariableDef[]> {
  return invoke<CssVariableDef[]>('get_css_variables', { projectPath });
}

/** Change the `@media` condition enclosing a rule, drift-guarded against `oldInner`. */
export function renameCssAtRule(
  projectPath: string,
  file: string,
  selector: string,
  mediaText: string | null,
  oldInner: string,
  newMedia: string
): Promise<void> {
  return invoke<void>('rename_css_at_rule', {
    projectPath,
    file,
    selector,
    mediaText,
    oldInner,
    newMedia,
  });
}

/** Change a rule's selector to `newSelector`, drift-guarded against `oldInner`. */
export function renameCssSelector(
  projectPath: string,
  file: string,
  selector: string,
  mediaText: string | null,
  oldInner: string,
  newSelector: string
): Promise<void> {
  return invoke<void>('rename_css_selector', {
    projectPath,
    file,
    selector,
    mediaText,
    oldInner,
    newSelector,
  });
}

/** Wrap a rule in an at-rule (e.g. `@media (...)`), drift-guarded against `oldInner`. */
export function wrapCssRule(
  projectPath: string,
  file: string,
  selector: string,
  mediaText: string | null,
  atPrelude: string,
  oldInner: string
): Promise<void> {
  return invoke<void>('wrap_css_rule', {
    projectPath,
    file,
    selector,
    mediaText,
    atPrelude,
    oldInner,
  });
}

/** Delete a whole rule from its stylesheet, drift-guarded against `oldInner`. */
export function deleteCssRule(
  projectPath: string,
  file: string,
  selector: string,
  mediaText: string | null,
  oldInner: string
): Promise<void> {
  return invoke<void>('delete_css_rule', { projectPath, file, selector, mediaText, oldInner });
}

/** A compact media chip for a row: `≥768` / `≤768` for width queries, else the raw
 *  condition; null when the rule isn't media-scoped. */
export function mediaChipLabel(row: Pick<CascadeRow, 'mediaText' | 'mediaMinPx'>): string | null {
  if (!row.mediaText && row.mediaMinPx == null) return null;
  const text = row.mediaText ?? '';
  const max = /max-width\s*:\s*([\d.]+)px/i.exec(text);
  if (max) return `≤${Math.round(parseFloat(max[1]))}`;
  const min = /min-width\s*:\s*([\d.]+)px/i.exec(text);
  if (min) return `≥${Math.round(parseFloat(min[1]))}`;
  if (row.mediaMinPx != null) return `≥${row.mediaMinPx}`;
  return text || null;
}

/**
 * True when a css write-back rejection means the source went stale under the
 * editor — recoverable by re-locating the rule and retrying. Covers BOTH backend
 * shapes from `edit_css.rs`: body drift ("source changed since you selected it")
 * and the zero-match case ("rule no longer matches"), which arises when the rule
 * was renamed/rewritten since the card was seeded (issue #584). Anything else
 * (Io, Process, non-stale Validation) is a real failure — don't retry it.
 */
export function isStaleCssRuleError(err: unknown): boolean {
  const e = asCommandError(err);
  return e.type === 'Validation' && /source changed|no longer matches/i.test(e.reason);
}

/** A stable key for a row — used both as the React key and the iframe preview key. */
export function rowKey(row: CascadeRow): string {
  return `${row.file ?? 'x'}|${row.selector ?? 'inline'}|${row.mediaMinPx ?? 0}|${row.index}`;
}

/** Build the bare CSS rule text (`selector { body }`) for a live preview. The iframe
 *  replaces the real rule in place inside its own `@media`/`@layer` group, so the
 *  preview text must NOT be media-wrapped (the group provides the context). */
export function formatRuleCss(selector: string, innerBody: string): string {
  return `${selector} {${innerBody}}`;
}

/** The author rules worth sending to the backend for source mapping (skip inline
 *  `style=""`, which is never editable as a rule). */
export function rulesToLocate(
  matched: MatchedRule[]
): { index: number; query: MatchedRuleQuery }[] {
  const out: { index: number; query: MatchedRuleQuery }[] = [];
  matched.forEach((m, index) => {
    if (m.origin === 'author' && m.selector) {
      out.push({
        index,
        query: {
          selector: m.selector,
          mediaText: m.mediaText,
          href: m.href,
          layer: m.layer,
          container: m.container,
          supports: m.supports,
        },
      });
    }
  });
  return out;
}

/** A class token that looks like CSS-Module output: webpack's default
 *  `[name]_[local]__[hash]` (Next.js — `Hero_title__x7f2a`), or any class ending in a
 *  `__`-joined hash of 4+ chars (Vite's `_title_x7f2a_1`-style is caught by locate
 *  failing anyway; this targets the double-underscore convention). */
// The hash segment must actually look like a hash — at least one digit or
// uppercase letter. Without that, BEM class names from third-party package
// CSS (`.react-datepicker__header`, `.card__title`) match the `__suffix`
// shape and get a wrong "edit the .module.css" explanation. Webpack/Next
// hashes are mixed-case base62 (`x7f2a`, `Ab3Kx`), so this stays reliable;
// a rare all-lowercase-alpha hash just falls back to the generic wording.
const CSS_MODULE_FULL_RE = /^\w+_\w+__(?=[A-Za-z0-9_-]*[0-9A-Z])[A-Za-z0-9_-]+$/;
const CSS_MODULE_HASH_SUFFIX_RE = /__(?=[A-Za-z0-9_-]*[0-9A-Z])[A-Za-z0-9_-]{4,}$/;

/** True when any class in `selector` looks like a build-time-hashed CSS-Module class.
 *  Used only to pick a better read-only explanation — never to gate editing (the
 *  locate result already decided that). */
export function looksLikeCssModuleSelector(selector: string): boolean {
  const classes = selector.match(/\.([A-Za-z0-9_-]+)/g) ?? [];
  return classes.some((c) => {
    const name = c.slice(1);
    return CSS_MODULE_FULL_RE.test(name) || CSS_MODULE_HASH_SUFFIX_RE.test(name);
  });
}

/** The `<name>.module.css` filename implied by a hashed class, when the class follows
 *  webpack's `[name]_[local]__[hash]` shape (`Hero_title__x7f2a` → `Hero.module.css`).
 *  Returns null when the shape doesn't pin a name — the caller falls back to generic
 *  wording rather than guessing. */
export function cssModuleFileHint(selector: string): string | null {
  const classes = selector.match(/\.([A-Za-z0-9_-]+)/g) ?? [];
  for (const c of classes) {
    const m = /^([A-Za-z0-9-]+?)_\w+__(?=[A-Za-z0-9_-]*[0-9A-Z])[A-Za-z0-9_-]+$/.exec(c.slice(1));
    if (m) return `${m[1]}.module.css`;
  }
  return null;
}

/** Read-only explanation for a rule locate couldn't map, worded for the actual cause
 *  when we can tell (CSS Modules in a Next.js project) instead of the generic bucket. */
function notFoundReason(selector: string | null, cssModulesHint: boolean): string {
  if (cssModulesHint && selector && looksLikeCssModuleSelector(selector)) {
    const file = cssModuleFileHint(selector);
    const source = file ? `${file}` : 'the .module.css file';
    return `styled by a CSS Module — class names are hashed at build time, so Ship Studio can't map this rule back to its source yet. Edit ${source} directly or ask the agent.`;
  }
  return 'not in a project stylesheet (UA / framework / scoped)';
}

export interface MergeCascadeOptions {
  /** The project bundles CSS Modules with hashed class names (Next.js) — locate
   *  misses on module-looking selectors get a specific explanation. */
  cssModulesHint?: boolean;
}

/** Join the iframe's matched rules with the backend's per-rule source locations
 *  into the panel's row model. `locByIndex` maps a matched-rule index → its
 *  resolved location; rows without one (inline, or unmapped) are read-only. */
export function mergeCascade(
  matched: MatchedRule[],
  locByIndex: Map<number, RuleLocation>,
  opts: MergeCascadeOptions = {}
): CascadeRow[] {
  return matched.map((m, index) => {
    const base: CascadeRow = {
      index,
      selector: m.selector,
      declarations: m.declarations,
      specificity: m.specificity,
      sourceOrder: m.sourceOrder,
      mediaText: m.mediaText,
      mediaMinPx: m.mediaMinPx,
      inactiveMedia: m.inactiveMedia,
      layer: m.layer,
      container: m.container ?? null,
      supports: m.supports ?? null,
      origin: m.origin,
      editable: false,
    };
    if (m.origin === 'inline') {
      return { ...base, readonlyReason: 'inline style — move it to a class to edit' };
    }
    const loc = locByIndex.get(index);
    if (!loc || loc.status === 'not_found') {
      return { ...base, readonlyReason: notFoundReason(m.selector, opts.cssModulesHint ?? false) };
    }
    if (loc.status === 'multiple') {
      return {
        ...base,
        sourceFiles: [...new Set(loc.files)],
        readonlyReason: 'this selector is defined in multiple files',
      };
    }
    return {
      ...base,
      editable: true,
      file: loc.file,
      line: loc.line,
      innerText: loc.inner_text,
    };
  });
}
