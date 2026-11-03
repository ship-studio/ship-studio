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
  /** Exact CSSOM location within the served stylesheet. This is runtime identity only;
   * source order is never treated as an authored source position. */
  runtimeIdentity?: CssRulePreviewIdentity;
  /** Zero-based CSSOM selector-list member matched by the selected element. */
  selectorMemberIndex?: number;
  /** Declarations serialized by CSSOM for exact authored-rule correlation. */
  identityDeclarations?: CssRuleDeclarationEvidence[];
  /** Full enclosing at-rule chain for authored source correlation. */
  contextPath?: string[];
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

export interface CssRuleDeclarationEvidence {
  property: string;
  value: string;
  important: boolean;
}

/** Validated CSSOM path used only for previewing the live browser rule. */
export interface CssRulePreviewIdentity {
  stylesheetIndex: number;
  rulePath: number[];
  href: string | null;
  rootHref: string | null;
  selectorList: string;
  selectorMemberIndex: number;
  declarations: CssRuleDeclarationEvidence[];
}

/** Exact authored occurrence returned by locate and revalidated before each write. */
export interface CssRuleSourceIdentity {
  sourcePath: string;
  sourceVersion: string;
  selectorOffset: number;
  selector: string;
  selectorMemberIndex: number;
  matchedSelector: string;
  selectorMembers: string[];
  /** True only when Rust proved an all-member split keeps source order/context and specificity. */
  selectorListSplitSafe?: boolean;
  innerText: string;
  contextPath: string[];
}

/** Exact source identity mapping returned when a shared @media wrapper is renamed. */
export interface CssRuleIdentityRemap {
  oldSelectorOffset: number;
  selectorMemberIndex: number;
  identity: CssRuleSourceIdentity;
}

export interface CssAtRuleRenameResult {
  selected: CssRuleSourceIdentity;
  remappedRules: CssRuleIdentityRemap[];
}

/** Result of splitting every list member into an adjacent source rule. */
export interface CssRuleSelectorListSplitResult {
  selected: CssRuleSourceIdentity;
  remappedRules: CssRuleIdentityRemap[];
}

/** Where a matched rule lives in source (mirrors the Rust `RuleLocation`,
 *  `#[serde(tag = "status", rename_all = "snake_case")]`). */
export type RuleLocation =
  | {
      status: 'resolved';
      file: string;
      line: number;
      inner_text: string;
      generated_css_output?: string;
      source_identity?: CssRuleSourceIdentity;
    }
  | {
      status: 'multiple';
      files: string[];
      rule_count: number;
      candidates: RuleSourceCandidate[];
    }
  | { status: 'not_found' };

/** One possible source rule for a read-only ambiguous cascade row. */
export interface RuleSourceCandidate {
  file: string;
  /** Physical host-file line, or null when the source is no longer readable. */
  line: number | null;
}

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
  selectorMemberIndex?: number;
  contextPath?: string[];
  identityDeclarations?: CssRuleDeclarationEvidence[];
  runtimeIdentity?: CssRulePreviewIdentity;
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
  /** Runtime CSSOM identity for preview; never used to locate an authored occurrence. */
  runtimeIdentity?: CssRulePreviewIdentity;
  selectorMemberIndex?: number;
  identityDeclarations?: CssRuleDeclarationEvidence[];
  contextPath?: string[];
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
  /** Verified generated stylesheet for the authored module, when source matching proved it. */
  generatedCssOutput?: string;
  /** Exact authored source rule occurrence used by every mutation. */
  sourceIdentity?: CssRuleSourceIdentity;
  /** Other members of a shared selector list receive the same property edits. */
  sharedSelectors?: string[];
  /** Candidate source files when the selector maps to more than one rule. */
  sourceFiles?: string[];
  /** Candidate rule locations when a selector maps to multiple source rules. */
  sourceCandidates?: RuleSourceCandidate[];
  /** Number of matching source rules, including multiple rules in the same file. */
  sourceRuleCount?: number;
  /** Why a rule is read-only, surfaced in the UI. */
  readonlyReason?: string;
  /** A not-yet-created rule for one of the element's own selectors — an empty editable
   *  card shown in cascade order; the rule is written to source on the first property. */
  draft?: boolean;
  /** Verified destination selected from resolved author rules for the first write.
   *  This is a proposed write target, not authored source provenance. */
  draftTargetFile?: string;
  /** A locally-created rule whose selector doesn't actually match the selected element
   *  (e.g. you typed `cool` for an `<h1>`). It's pinned so it doesn't vanish, but it
   *  isn't part of this element's cascade — the card says so rather than implying it applies. */
  unmatched?: boolean;
}

/** Source provenance known for a cascade row. Multiple candidates stay distinct from
 *  a resolved file so presentation never implies that one candidate was selected. */
export type CascadeSourceProvenance =
  | { kind: 'resolved'; file: string }
  | {
      kind: 'multiple';
      files: string[];
      candidates?: RuleSourceCandidate[];
      ruleCount?: number;
    };

/** Read the row's actual author-source provenance, if one was returned by locate. */
export function cascadeSourceProvenance(row: CascadeRow): CascadeSourceProvenance | undefined {
  if (row.origin !== 'author' || row.draft) return undefined;
  if (row.file) return { kind: 'resolved', file: row.file };

  const files = [...new Set(row.sourceFiles ?? [])].sort();
  return files.length > 0
    ? {
        kind: 'multiple',
        files,
        candidates: row.sourceCandidates,
        ruleCount: row.sourceRuleCount,
      }
    : undefined;
}

/** Preserve the editor's existing write-target choice: the first editable, resolved
 *  author rule in cascade order. Candidate-only mappings and discovered sheets are
 *  deliberately excluded because neither identifies a safe destination. */
export function selectCssRuleTargetFile(rows: readonly CascadeRow[]): string | undefined {
  return rows.find((row) => row.origin === 'author' && row.editable && !row.draft && row.file)
    ?.file;
}

/** Return the explicit target the save path must use for this row. Draft destinations
 *  remain separate from `file`, which is reserved for authored source provenance. */
export function cssRuleWriteTargetFile(row: CascadeRow): string | undefined {
  return row.draft ? row.draftTargetFile : row.file;
}

/** Stable identity for actual source provenance; candidate order is not meaningful. */
export function cascadeSourceProvenanceKey(source: CascadeSourceProvenance | undefined): string {
  if (!source) return JSON.stringify(['unknown']);
  return source.kind === 'resolved'
    ? JSON.stringify(['resolved', source.file])
    : JSON.stringify([
        'multiple',
        source.files,
        source.ruleCount ?? null,
        source.candidates?.map(({ file, line }) => [file, line]) ?? null,
      ]);
}

/** Map a batch of cascade matches to their source locations (index-aligned). */
export function locateCssRules(
  projectPath: string,
  matched: MatchedRuleQuery[]
): Promise<RuleLocation[]> {
  return invoke<RuleLocation[]>('locate_css_rules', { projectPath, matched });
}

/** Resolve a displayed cascade rule inside one candidate source file.
 *
 * The backend returns a physical host-file line for embedded Astro styles, so
 * callers should pass the recorded source reference (including `?style=N`). When
 * `sourceLine` is known, it pins resolution to that exact rule before translation.
 */
export function resolveCssSourceLine(
  projectPath: string,
  file: string,
  matched: MatchedRuleQuery,
  sourceLine?: number
): Promise<number> {
  return invoke<number>('resolve_css_source_line', {
    projectPath,
    file,
    matched,
    sourceLine: sourceLine ?? null,
  });
}

/** Write an edited rule body back to source, drift-guarded against `oldInner`. */
export function applyCssRuleText(
  projectPath: string,
  file: string,
  selector: string,
  mediaText: string | null,
  oldInner: string,
  newInner: string,
  sourceIdentity: CssRuleSourceIdentity
): Promise<CssRuleSourceIdentity> {
  return invoke<CssRuleSourceIdentity>('apply_css_rule_text', {
    projectPath,
    file,
    selector,
    mediaText,
    oldInner,
    newInner,
    sourceIdentity,
  });
}

/** Create a new (empty) rule for `selector` in `file`, optionally wrapped in an
 *  at-rule condition (`@media (max-width: …)`, `@container …`, `@supports …`). */
export function createCssRule(
  projectPath: string,
  file: string,
  selector: string,
  atPrelude?: string | null
): Promise<CssRuleSourceIdentity> {
  return invoke<CssRuleSourceIdentity>('create_css_class', {
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
  newMedia: string,
  sourceIdentity: CssRuleSourceIdentity
): Promise<CssAtRuleRenameResult> {
  return invoke<CssAtRuleRenameResult>('rename_css_at_rule', {
    projectPath,
    file,
    selector,
    mediaText,
    oldInner,
    newMedia,
    sourceIdentity,
  });
}

/** Replace the complete authored selector prelude, drift-guarded by exact source identity. */
export function replaceCssSelectorList(
  projectPath: string,
  file: string,
  selector: string,
  mediaText: string | null,
  oldInner: string,
  newSelectorList: string,
  sourceIdentity: CssRuleSourceIdentity
): Promise<CssRuleSourceIdentity> {
  return invoke<CssRuleSourceIdentity>('rename_css_selector', {
    projectPath,
    file,
    selector,
    mediaText,
    oldInner,
    newSelector: newSelectorList,
    sourceIdentity,
  });
}

/** Legacy name retained for the animation editor; CSS selector edits now replace a list. */
export function renameCssSelector(
  projectPath: string,
  file: string,
  selector: string,
  mediaText: string | null,
  oldInner: string,
  newSelector: string,
  sourceIdentity: CssRuleSourceIdentity
): Promise<CssRuleSourceIdentity> {
  return replaceCssSelectorList(
    projectPath,
    file,
    selector,
    mediaText,
    oldInner,
    newSelector,
    sourceIdentity
  );
}

/** Wrap a rule in an at-rule (e.g. `@media (...)`), drift-guarded against `oldInner`. */
export function wrapCssRule(
  projectPath: string,
  file: string,
  selector: string,
  mediaText: string | null,
  atPrelude: string,
  oldInner: string,
  sourceIdentity: CssRuleSourceIdentity
): Promise<CssRuleSourceIdentity> {
  return invoke<CssRuleSourceIdentity>('wrap_css_rule', {
    projectPath,
    file,
    selector,
    mediaText,
    atPrelude,
    oldInner,
    sourceIdentity,
  });
}

/** Delete a whole rule from its stylesheet, drift-guarded against `oldInner`. */
export function deleteCssRule(
  projectPath: string,
  file: string,
  selector: string,
  mediaText: string | null,
  oldInner: string,
  sourceIdentity: CssRuleSourceIdentity,
  removeMemberOnly = false
): Promise<void> {
  return invoke<void>('delete_css_rule', {
    projectPath,
    file,
    selector,
    mediaText,
    oldInner,
    sourceIdentity,
    removeMemberOnly,
  });
}

/** Delete several sibling rules atomically from their shared source snapshot. */
export function deleteCssRules(
  projectPath: string,
  file: string,
  sourceIdentities: CssRuleSourceIdentity[]
): Promise<void> {
  return invoke<void>('delete_css_rules', { projectPath, file, sourceIdentities });
}

export function makeCssSelectorIndependent(
  projectPath: string,
  file: string,
  selector: string,
  sourceIdentity: CssRuleSourceIdentity
): Promise<CssRuleSourceIdentity> {
  return invoke<CssRuleSourceIdentity>('make_css_selector_independent', {
    projectPath,
    file,
    selector,
    sourceIdentity,
  });
}

/** Split all members in one exact selector-list source rule. */
export function splitCssSelectorList(
  projectPath: string,
  file: string,
  sourceIdentity: CssRuleSourceIdentity
): Promise<CssRuleSelectorListSplitResult> {
  return invoke<CssRuleSelectorListSplitResult>('split_css_selector_list', {
    projectPath,
    file,
    sourceIdentity,
  });
}

export interface CssConsolidationCandidate {
  file: string;
  before: string;
  after: string;
  sourceVersion: string;
  first: CssRuleSourceIdentity;
  second: CssRuleSourceIdentity;
}

export interface CssConsolidationReview {
  candidates: CssConsolidationCandidate[];
  unavailableReason: string | null;
}

export function reviewCssConsolidations(projectPath: string): Promise<CssConsolidationReview> {
  return invoke<CssConsolidationReview>('review_css_consolidations', { projectPath });
}

export function applyCssConsolidation(
  projectPath: string,
  candidate: CssConsolidationCandidate
): Promise<void> {
  return invoke<void>('apply_css_consolidation', { projectPath, candidate });
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

/** Insert a draft before the first lower-specificity active rule, above inactive rules. */
function insertDraftByCascade(rows: CascadeRow[], draft: CascadeRow): void {
  const compareSpecificity = (a: CascadeRow['specificity'], b: CascadeRow['specificity']) =>
    a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  let index = rows.findIndex(
    (row) => !row.inactiveMedia && compareSpecificity(row.specificity, draft.specificity) < 0
  );
  if (index < 0) {
    index = rows.findIndex((row) => row.inactiveMedia);
    if (index < 0) index = rows.length;
  }
  rows.splice(index, 0, draft);
}

/** Reposition empty draft cards using the same specificity ordering as initial cascade setup. */
export function positionCascadeDrafts(rows: readonly CascadeRow[]): CascadeRow[] {
  const drafts = rows.filter((row) => row.draft);
  const orderedRows = rows.filter((row) => !row.draft);
  for (const draft of drafts) insertDraftByCascade(orderedRows, draft);
  return orderedRows;
}

/** Apply fresh viewport activity and cascade order without changing row identities.
 *  Matched rows keep stable keys; draft cards return to their specificity-based positions. */
export function applyCascadeActivity(
  rows: readonly CascadeRow[],
  rules: readonly MatchedRule[]
): CascadeRow[] {
  const rowSlots = new Map<string, number[]>();
  rows.forEach((row, index) => {
    if (row.sourceOrder == null) return;
    const key = JSON.stringify([row.sourceOrder, row.selector]);
    const slots = rowSlots.get(key);
    if (slots) slots.push(index);
    else rowSlots.set(key, [index]);
  });

  const matchedSlots = new Set<number>();
  const orderedRows: CascadeRow[] = [];
  for (const rule of rules) {
    const key = JSON.stringify([rule.sourceOrder, rule.selector]);
    const index = rowSlots.get(key)?.shift();
    if (index === undefined) continue;

    matchedSlots.add(index);
    orderedRows.push({
      ...rows[index],
      inactiveMedia: rule.inactiveMedia,
      declarations: rule.declarations,
    });
  }

  let orderedIndex = 0;
  const refreshedRows = rows.map((row, index) =>
    matchedSlots.has(index) ? orderedRows[orderedIndex++] : row
  );
  return positionCascadeDrafts(refreshedRows);
}

export interface MediaCascadeGroup {
  kind: 'media';
  /** Stable identity for this contiguous run of one source wrapper. */
  key: string;
  condition: string;
  rows: CascadeRow[];
}

export type CascadeGroupItem = { kind: 'rule'; row: CascadeRow } | MediaCascadeGroup;

/** Group only contiguous sibling rules that share the same authored `@media` wrapper. */
export function groupCascadeRows(rows: readonly CascadeRow[]): CascadeGroupItem[] {
  const items: CascadeGroupItem[] = [];

  const contextKey = (row: CascadeRow) =>
    JSON.stringify([
      cascadeSourceProvenanceKey(cascadeSourceProvenance(row)),
      row.mediaText,
      row.layer ?? '',
      row.container ?? '',
      row.supports ?? '',
    ]);

  for (const row of rows) {
    // A draft selector has no authored wrapper yet. Keep its suggested context on
    // the rule card, but don't fold it into a source-backed media run.
    if (!row.mediaText || row.draft) {
      items.push({ kind: 'rule', row });
      continue;
    }

    // Keep source files and other enclosing contexts in the identity. Two identical
    // conditions in separate files/contexts are not one editable wrapper. A prior
    // matching group is reusable only when it is the immediately preceding item.
    const key = contextKey(row);
    const previous = items[items.length - 1];
    if (previous?.kind === 'media' && previous.key === key) {
      previous.rows.push(row);
    } else {
      items.push({ kind: 'media', key, condition: row.mediaText, rows: [row] });
    }
  }

  // The context key alone repeats when an @media wrapper recurs later in the
  // list. Include the member rows as a direction-independent run identity for
  // React keys and per-run collapse state.
  return items.map((item) =>
    item.kind === 'media'
      ? { ...item, key: JSON.stringify([item.key, item.rows.map(rowKey).sort()]) }
      : item
  );
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
          ...(m.selectorMemberIndex !== undefined
            ? { selectorMemberIndex: m.selectorMemberIndex }
            : {}),
          ...(m.contextPath !== undefined ? { contextPath: m.contextPath } : {}),
          ...(m.identityDeclarations !== undefined
            ? { identityDeclarations: m.identityDeclarations }
            : {}),
          ...(m.runtimeIdentity !== undefined ? { runtimeIdentity: m.runtimeIdentity } : {}),
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
  return 'stylesheet source could not be mapped';
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
      runtimeIdentity: m.runtimeIdentity,
      selectorMemberIndex: m.selectorMemberIndex,
      identityDeclarations: m.identityDeclarations,
      contextPath: m.contextPath,
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
      const files = [...new Set(loc.files)];
      const ruleCount = loc.rule_count ?? loc.candidates.length;
      const readonlyReason =
        files.length === 1
          ? `this selector matches ${ruleCount} source rules in this file; inspect the candidate rules in Code`
          : `this selector matches ${ruleCount} source rules across ${files.length} files; inspect the candidates in Code`;
      return {
        ...base,
        sourceFiles: files,
        sourceCandidates: loc.candidates,
        sourceRuleCount: ruleCount,
        readonlyReason,
      };
    }
    return {
      ...base,
      editable: loc.source_identity != null,
      file: loc.file,
      line: loc.line,
      innerText: loc.inner_text,
      generatedCssOutput: loc.generated_css_output,
      sourceIdentity: loc.source_identity,
      sharedSelectors: loc.source_identity?.selectorMembers.filter(
        (_, memberIndex) => memberIndex !== loc.source_identity?.selectorMemberIndex
      ),
      readonlyReason: loc.source_identity ? undefined : 'exact source rule identity is unavailable',
    };
  });
}
