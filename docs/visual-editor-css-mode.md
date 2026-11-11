# Visual Editor — CSS Mode (class-based editing for HTML/CSS projects)

## Why this exists

The visual editor today only lights up for **React/Astro/Shopify + Tailwind**
projects. Its entire write path mutates the *class-attribute string* with
Tailwind utility tokens (`applyToken` → `twMerge` → write `className`), and
"custom classes" are just `@apply` lists. There is **no path that edits a CSS
rule**.

That leaves a whole class of projects — plain `.html`/`.css` sites and Astro
pages with static markup — with a working live preview but **no edit toggle at
all** (`statichtml` is excluded from `editorFramework`, and the
`tailwindActive` gate blocks non-Tailwind projects).

CSS Mode adds a **second style engine** to the same visual-editor shell. For
projects whose styling lives in real, class-based stylesheets, a style change
becomes a **CSS rule edit** (`padding: 24px`, any property, any value, any
unit) instead of a utility-token swap. Same selection, same tree, same panel —
different backend dialect.

This is strictly more capable than the Tailwind path for these projects: you
edit named CSS rules with the full expressiveness of CSS, not a constrained
utility scale.

## Reliability strategy: convention + agent prep, not heroic parsing

We do **not** try to robustly parse arbitrary CSS. Reliability comes from
**narrowing the input space to a convention** and using a **review-then-run
agent prompt** (the same pattern as i18n setup / next-intl App Router setup) as
the on-ramp into that convention.

- The engine is **strict and fail-closed**: if the source doesn't match the
  convention, it returns a typed status (`Inline`, `Multiple`, `NotFound`, …)
  and refuses to guess — it never silently writes the wrong thing.
- Off-spec projects get a **"Prepare for visual editing"** action: a reviewable
  agent prompt that refactors the project toward the convention (extract inline
  styles into semantic classes, consolidate stylesheets, name things), then
  re-detect.

The deliberate trade: **some real projects won't be editable until prepped.**
That is the cost of reliability over universal coverage; the prep prompt is what
makes that feel like an on-ramp instead of a wall.

## The convention (v1)

A project/page is "CSS-editable" when:

1. **Pages are real HTML** — `.html` files, or `.astro` files with static
   template markup (no `{expr}` / component on the edited node).
   Astro also indexes authored HTML fragments under `src/`, such as files
   imported with `?raw` and rendered with `set:html`; generated/export HTML
   outside `src/` stays excluded.
2. **Styling is external and class-based** — linked stylesheet(s); managed
   styles do not live in inline `style="…"` (inline → read-only + "extract to
   class").
3. **Multi-class elements are fine** — base + modifier/combo classes (BEM,
   `card card--active`, component + utility) all work; the class bar picks which
   class's rule you edit. The constraint is on the *class→rule* mapping, not the
   *element→class* count.
4. **An editable class resolves to exactly one rule** in the indexed
   stylesheets. A class defined by multiple scattered rules → read-only +
   flagged (`Multiple`), never an ambiguous guess — consolidate it into one.
5. **Breakpoints are a fixed `@media (min-width: …)` set**, so a responsive edit
   writes into the correct media block (creating it if absent).

Anything off-spec → the prep prompt.

## Architecture

The visual-editor shell is already a frontend over a source-mutation engine.
CSS Mode adds a parallel engine and routes to it by project type. Reused as-is:

- The in-iframe selection script (`proxy/select_script.html`) — already
  framework-agnostic; it runs on static-HTML previews today, nothing listens.
- The `ss:*` postMessage protocol, selection boxes, element tree, panel shell.
- **Live preview**: `postMutate(className, rules)` already pushes *raw
  breakpoint-scoped CSS declarations* to the iframe. The Tailwind path compiles
  utilities → CSS to feed it; CSS Mode feeds declarations **directly**.

Net-new:

- **Rust CSS engine** (`commands/edit_css.rs`) — locate a class's rule, edit a
  single declaration surgically, create a class + attach it. *(Phase 1 ✓)*
- **Isolated CSS editor** — a SEPARATE `useCssEditor` hook + `CssEditorPanel`
  (not a refactor of the Tailwind hook), reusing the in-iframe `ss:*` protocol.
  *(Phase 2 ✓)*
- **Gating** — the toggle lights up for vanilla Astro (Astro without Tailwind),
  mutually exclusive with the Tailwind editor. `statichtml` is a later phase
  (its preview path needs the select script injected). *(Phase 2 ✓)*
- **Navigator** — the element tree reuses `useElementTree`/`ElementTreePanel`;
  selecting a node fires the same `ss:select` the CSS editor handles. *(Phase 3 ✓)*
- **Prep flow** — a `LanguagesModal`-style reviewable agent prompt
  (`buildCssPrepPrompt`) surfaced from the empty + read-only states. *(Phase 3 ✓)*
- **Structured controls + Code view** — `lib/cssControls.ts` schema +
  `CssControls` render category tabs (Layout, Spacing, Size, Type, Background,
  Border) of segmented / select / length / color widgets, each reading & writing
  one CSS property off the rule. A Visual/Code toggle swaps to a raw, editable
  CSS textarea (diffed and saved via `saveDeclarations`) for a direct connection
  to the source. *(Phase 4 ✓)*
- **Remaining** — more categories (shadows, effects, visibility, 4-side
  spacing), icon affordances for align/justify, and the static-HTML project path
  (its preview must inject the select script). *(Phase 4+ — next)*

## Phase 1 — Rust CSS engine (this phase)

New module `src-tauri/src/commands/edit_css.rs`. Conservative, dependency-free
CSS locator + surgical writer. Heavily unit-tested — this is where reliability
lives.

Core pieces:

- **Stylesheet discovery** — index `.css` files under the project (excluding
  `node_modules`, `dist`, build output).
- **Rule locator** — a brace/string/comment-aware tokenizer that records, for
  each style rule: selector list, the byte span of the declaration block, the
  1-based line, and the enclosing `@media` prelude (if any). Bails loudly on
  anything outside the convention (preprocessor syntax, nested at-rules beyond
  media).
- **Declaration parse/edit** — `parse_declarations(block)` and a surgical
  `set_declaration(css, span, property, value)` that updates an existing
  declaration in place, appends if missing, or removes if `value: None`, all
  while preserving surrounding formatting.
- **Commands** (`Result<T, CommandError>`, `validate_project_path`,
  `#[tracing::instrument]`):
  - `resolve_css_rule(project_path, signature, breakpoint_min_px?)` →
    `CssResolution` (`Resolved` with declarations | `Multiple` | `Inline` |
    `NeedsClass` | `NotFound`).
  - `set_css_declaration(project_path, file, selector, breakpoint_min_px?,
    property, value?)` → surgical write to that rule's block.
  - `create_css_class(project_path, authored_sheet, selector, declarations)` →
    append a rule to the authored stylesheet (element class-attribute attach
    reuses the existing class-attr surgery once `.html` is added to the source
    set).

Out of scope for Phase 1: any frontend wiring, gating changes, the prep prompt,
expanded controls. Those are Phases 2–4.

## Analytics

CSS Mode reuses the existing visual-editor events
(`visual_edit_started/stopped`, `visual_style_saved`, `visual_element_selected`)
with a `mode: 'css' | 'tailwind'` property, plus prep-flow events when Phase 3
lands. See `docs/analytics.md`.
