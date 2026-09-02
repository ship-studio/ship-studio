# Ship Studio Design System

The reference for tokens and UI primitives. Audience: you're about to build a feature and need
the right token or component in under a minute. Canonical sources (always trust these over docs):

- Tokens: [src/styles/global/token-manifest.json](../src/styles/global/token-manifest.json) and the ordered
  files it names (`fonts.css`, `tokens-core.css`, `tokens-semantic.css`, `tokens-components.css`,
  and `tokens-compatibility.css`)
- Global base rules: [src/styles/global/base.css](../src/styles/global/base.css) — reset, loading
  primitives, and plugin-stable selectors; canonical token definitions live in the ordered token
  files
- CSS ownership: [docs/css-ownership.md](css-ownership.md) and the executable inventory in
  `scripts/check-css-ownership.mjs`
- Primitives: [src/components/primitives/](../src/components/primitives/)
- Primitive registry: [docs/design-system-registry.json](design-system-registry.json) and its
  generated [inventory](design-system.generated.md)
- The rules and rationale: [CLAUDE.md → How to Do Things in Ship Studio](../CLAUDE.md#how-to-do-things-in-ship-studio)
  and [docs/CONTRIBUTING_PATTERNS.md](CONTRIBUTING_PATTERNS.md)

## One-minute discovery path

Start with the interaction you are building, then use the canonical primitive from the generated
registry:

| I need… | Start with… |
| --- | --- |
| An action | `Button`, `IconButton`, `TextButton`, `ToggleButton`, or `MenuButton` |
| A choice | `SegmentedControl`, `PropertyField`, or `ValueField` |
| A field | `TextField` or `ValueField` |
| A panel | `DockablePanel`, `EmptyState`, or `PanelResizeHandle` |
| Status or notification | `Spinner`, `EmptyState`, or `ToastList` |
| An overlay or menu | `ModalFrame`, `Dropdown`, or `Tooltip` |
| Navigation | `Tabs` |
| A typography treatment | `MiddleTruncate` or the semantic text roles in the token table |

Use the generated inventory for the exact props, states, accessibility contract, stylesheet owner,
example, tests, and lifecycle status. Add a new row to the registry when a new public primitive
source file is introduced.

## Icons and SVG graphics

SVG ownership is split by reuse and meaning:

- `src/assets/icons/` contains reusable product icons and brand marks.
- `src/assets/icons/old-icons/` contains app-specific artwork that is reusable inside Ship Studio
  but is not part of the primary shared icon set.
- `src/assets/graphics/` contains feature artwork with its own visual or layout contract.

Every SVG filename uses lowercase kebab-case, contains only letters, numbers, and single hyphens,
and has no trailing numeric segment. Every SVG has one numeric `viewBox`. The icon checker rejects
scripts, `foreignObject`, inline event handlers, and external references.

Shared icons are represented by semantic modules in `src/components/icons/`: `common`, `editor`,
`editor-controls`, `layout`, `status`, `utility`, and `brand`. `index.tsx` is the public boundary;
feature code imports shared icons from `@/components/icons`. The module owns the asset import and
the semantic name, while the asset owns the artwork.

`IconProps` extends SVG props without `width` or `height` and adds `size` and `title`. `IconMeta`
records the name, asset source, `ui` or `brand` kind, default size, compact behavior, and optional
stroke width. `createIcon` returns a ref-forwarding component, applies metadata to the SVG root,
preserves caller props and classes, and keeps artwork replaceable without changing consumers.

Standard icons use their metadata default size. The compatibility sizing rules map a standard
request of 12px to 14px and 14px to 16px. Compact icons map requests of 12px or 14px to 14px;
other explicit sizes remain unchanged.

UI artwork uses `currentColor` so the consuming component controls its color. Brand artwork keeps
fixed brand colors where the mark requires them. Feature graphics use CSS custom properties for
token-valued colors and preserve their feature-specific geometry.

Icons are decorative by default: an unlabelled icon has `aria-hidden="true"`. A `title`,
`aria-label`, or `aria-labelledby` makes an icon labelled and gives it `role="img"` unless the
caller supplies another role; labelled icons are not hidden. The caller can provide explicit
accessible SVG props, classes, and refs.

### Importing a new icon

Treat `src/assets/icons/import/` as a temporary inbox. When asked to add an icon to a feature:

1. Check that the filename is descriptive lowercase kebab-case and that the SVG has one numeric
   `viewBox`.
2. For UI icons, change every artwork `stroke` and `fill` colour to `currentColor`, but preserve
   `opacity`, `stroke-opacity`, `fill-opacity`, `fill="none"`, masks, and clip paths. Brand marks
   keep any colours that are part of the brand.
3. Move reusable UI or brand icons into `src/assets/icons/`. Use `old-icons/` only for
   app-specific legacy artwork; use `graphics/` for feature artwork that has its own layout
   contract. Move each processed file out of `import/`; never reference a newly integrated shared
   icon from the inbox.
4. Import the asset with `?react` in the semantic module under `src/components/icons/` that owns
   its meaning (`common`, `editor`, `editor-controls`, `layout`, `status`, `utility`, or `brand`).
5. Wrap it with `createIcon`, add complete `IconMeta`, and use a semantic export name ending in
   `Icon`. The existing `index.tsx` module re-exports each category as the public boundary.
6. Replace the feature's placeholder icon with the new export, importing only from
   `@/components/icons`.
7. Run `pnpm icons:check` and the smallest relevant test. Also run the repository's required CI
   gates before declaring a larger feature complete.

Replacing artwork at an existing asset path keeps consumers unchanged.

To add an app-specific icon, place it in `src/assets/icons/old-icons/`, use the same semantic
wrapper, and record its `old-icons` source in the metadata.

To add feature artwork, place the SVG in `src/assets/graphics/` and import it directly with
`?react` from the owning feature. The feature passes its class and layout props and marks
decorative artwork as hidden. Static inline SVG is prohibited in feature components. The sole
dynamic exception is `BranchGraph.tsx`, whose one generated root carries
`data-dynamic-svg="branch-graph"`.

`pnpm icons:status` reports the asset and export inventory, and `pnpm icons:check` validates the
tree, metadata, public module exports, and dynamic SVG exception. The development-only gallery is
available with `?iconGallery=1`; it discovers components from `iconMeta` and displays their name,
kind, and source.

## Design tokens

The current styling baseline is the Ship Studio Figma Variables system. Global tokens are split into
four enforceable layers. Import order is defined by `token-manifest.json` and checked in CI:

| Layer | Naming | Rule |
| --- | --- | --- |
| Core primitive | `--color-*`, `--space-*`, `--radius-*`, `--stroke-*`, numeric `--font-size-*`, font families/weights, line heights, tracking | Raw palette, scale, type, and effect ingredients. Define here; do not consume directly from feature or component selectors except for a checked-in migration baseline. |
| Semantic role | `--surface-*`, `--text-*`, `--border-*`, `--accent-*`, semantic `--font-size-*` roles | Product-facing intent. Prefer values that reference core primitives. Feature styles and shared components consume this layer. |
| Component contract | `--button-*`, `--editor-*`, `--tree-*`, `--size-*`, `--z-*`, and other owner-specific names | Stable dimensions and recipes owned by one component or UI domain. Use when a value is a component contract rather than a product-wide role. |
| Compatibility | Legacy public names and migration aliases | Frozen API or temporary bridge only. Do not add new product usage; migration aliases must include a removal condition. |

Representative Figma mappings are `background-app → surface-app`, `background-panel →
surface-panel`, `background-control → surface-control`, `background-selected →
surface-selected`, `border-subtle → border-subtle`, `accent-active → accent-active`, and
`size-radius-control → radius-control`. Figma text/effect styles are mapped into semantic
typography and shadow tokens rather than treated as primitives.

### Token migration inventory

The migration inventory is deliberately conservative. Exact imports and obvious semantic
reattachments are automated; unresolved values remain explicit and are marked for review.

| Source | Classification | Code treatment |
| --- | --- | --- |
| Figma color, spacing, radius, stroke, and type Variables | Exact | Imported into `--color-*`, `--space-*`, `--radius-*`, `--stroke-*`, and `--font-*` primitives. |
| Figma `background-*`, `text-*`, `border-*`, and `accent-*` Variables | Obvious semantic | Reattached to category-first `--surface-*`, `--text-*`, `--border-*`, and `--accent-*` roles. |
| Figma `Body M/Regular`, `Body S/Regular`, `Code S/Regular`, `Button Effects`, `Input inner shadow`, and `Window shadow` styles | Obvious semantic | Exposed through `--font-ui`, `--font-code`, `--shadow-button`, `--shadow-input-inset`, and `--shadow-window`; these are not primitives. |
| Legacy `--bg-*`, `--accent`, `--action`, `--border`, `--warning`, `--success`, `--error`, and `--font-code` names | Migrated | Internal product usages are reattached to canonical semantic roles; the compatibility layer now retains only unresolved raw values. |
| Existing error palette (`#f44747`, `#ef4444`, `#dc2626`) | Ambiguous / review | Retained as explicit `--color-red-error*` values because no corresponding Figma semantic was observed. |
| Feature-local info, purple, Slack, ANSI, and code-syntax colors | Feature semantic | Preserved where their product meaning is specific; do not use them as general surface or text roles. |
| Terminal colors and icon/symbol typography | Platform/component input | xterm keeps explicit canvas colors; Geist Mono is used for code, while JetBrains Mono Nerd Font is retained for glyph coverage. |
| Button `default`, `primary`, `secondary`, `danger`, `ghost`, `warning`, and `variable` states | Obvious semantic | `default` is the Figma neutral solid role, `secondary` is neutral outline, `warning` is amber, and `danger` remains destructive red. |

This pass imports the current dark application mode. Other Figma modes remain part of the source
inventory but are not wired into the application yet.

Definitions live in the files listed by `token-manifest.json`. Never write raw hex colors, raw
spacing px, raw z-index numbers, or raw durations in CSS — use a token (CI enforces colors; review
enforces the rest). A core primitive is an ingredient, not a styling API: if a selector needs a
value, consume a semantic role or an owner-appropriate component token.

| Group | Tokens | When to use |
| --- | --- | --- |
| Surfaces | `--surface-app` / `--surface-panel` / `--surface-control` / `--surface-selected` / `--surface-recessed` | App background → panels → controls → selected rows; recessed wells are used for terminals, log output, and code editors. |
| Text | `--text-primary` / `--text-secondary` / `--text-muted` / `--text-faint` / `--text-terminal-strong` | Default → supporting labels → muted hints → faint chrome; terminal output has its own readable roles. |
| Brand / interactive | `--accent-active` / `--accent-active-hover` / `--accent-success` / `--accent-warning` / `--text-on-accent` | Figma active green and warning amber with explicit state intent. |
| Status | `--accent-success`, `--accent-warning`, `--accent-error`, `--accent-error-light`, `--accent-error-deep`, `--modified-yellow` | Semantic states. Error values are retained as reviewed legacy inputs until their Figma mapping is confirmed. |
| Info blue | `--info(-hover/-light/-dark)` | Links, info banners, "open" PR state, focus accents. |
| Purple | `--purple`, `--purple-light`, `--purple-deep-rgb` | AI / agent surfaces only (skills, MCP, plugin marketplace). |
| Slack | `--slack-pink`, `--slack-lavender(-bright)` | Slack community CTA branding only (dashboard, setup, support panel). |
| RGB triplets | `--accent-*-rgb` and feature `--*-rgb` values | For alpha tints only, e.g. `rgba(var(--accent-error-rgb), 0.1)`. Each must stay in sync with its solid token. |
| Tints | `--tint-subtle` / `--tint` / `--tint-strong` | White hover/selection washes on dark surfaces (5/8/10% white). |
| Overlays | `--overlay-30` … `--overlay-80` | Black scrims behind modals, image dimming. Suffix = alpha %. |
| ANSI palette | `--ansi-green/red/yellow/blue(-dark)` (+ `-rgb`) | Terminal-flavored output: health diagnostics, browser tools, log rendering. Not for general UI status — that's the status group. |
| Code syntax | `--code-keyword/string/property/comment` | VS Code dark syntax colors for code mode and diff rendering. |
| Structure / hover | `--border-default/subtle/strong`, `--surface-control-hover`, `--surface-selected` | Figma border hierarchy and standard hover/selected roles for rows, tabs, and bordered cards. Legacy `--border` and `--bg-hover` consumers now use these canonical roles. |
| Spacing | `--space-*` primitives plus `--spacing-3xs` … `--spacing-2xl` semantic scale | Product CSS uses `--spacing-*`. Add a semantic spacing role when the existing scale does not express the intent; do not use `--space-*` directly in a selector. |
| Radius | `--radius-control`, `--radius-card`, `--radius-4/6/8/12/999` | Controls use 6px, cards 8px, and pills/circles use the 999px/full roles. |
| Z-index tiers | `--z-dropdown` (100) → `--z-preview-fullscreen` (900) → `--z-modal-overlay/-modal` (1000/1001) → `--z-tooltip` (1100) → `--z-notification` (1200) → `--z-app-*` / `--z-toast*` (9999–10010) | Pick the tier, not a number: floating menus < fullscreen preview < modals < tooltips < toasts < global app overlays. (`--z-changelog-sentinel` is the deliberate ceiling.) |
| Layout dims | `--editor-panel-w`, `--preview-toolbar-h`, `--tree-panel-w` | Shared panel dimensions that must agree across files (and with `PANEL_WIDTH` in `VisualEditorPanel.tsx`). |
| Shadows | `--shadow-sm` / `--shadow` / `--shadow-md` / `--shadow-lg` | Elevation: small popovers → dropdowns → modals → fullscreen layers. |
| Transitions | `--transition-fast` (0.1s) / `--transition` (0.15s) / `--transition-slow` (0.3s) | Duration + easing bundled: `transition: background var(--transition)`. |
| Type scale | Numeric `--font-size-*` primitives, semantic `--font-size-h1/hero/heading/subhead/body-*/control/label/button/menu-item/badge`, `--font-ui`, `--font-code`, `--font-symbol` | Define each numeric size once in the core scale. Every rendered text kind uses a semantic role that references that scale; Geist is for UI, Geist Mono for code/editor styling, and JetBrains Nerd Font for terminal/symbol glyph coverage. |

Need a value that doesn't exist? Add it to the smallest appropriate layer, update the inventory, and
run `pnpm check:token-layers`. Do not add a new alias to the compatibility file unless it is a
plugin contract or a time-bounded migration bridge.

### Token workflow

1. **Need a new ingredient?** Add a literal primitive to `tokens-core.css` only when it belongs to
   the shared palette, scale, type, radius, shadow, or duration vocabulary.
2. **Need a product meaning?** Add a semantic role to `tokens-semantic.css` and reference the core
   primitive. For typography, add or reuse a semantic text role (`body-md`, `label`, `button`, and
   so on) rather than styling a selector with a numeric size.
3. **Need an owner-specific contract?** Add a component token to `tokens-components.css`, document
   its owner, and consume that token only within the owning domain.
4. **Need to preserve an external name?** Add or retain it in `tokens-compatibility.css`, mark it as
   `compatibility` or `migration` in the inventory, and record when a migration alias can be removed.

Run `pnpm tokens:inventory` after changing definitions. `pnpm check:token-layers` verifies manifest
order, duplicate definitions, allowed layer direction, inventory freshness, and the checked-in
baseline for existing primitive or migration-alias consumers. The baseline prevents new direct
primitive usage while existing domains are migrated one at a time.

### Compatibility follow-up

`tokens-compatibility.css` now contains only raw legacy values with no exact core or semantic match.
Suggested next owners are:

- Move info blue and modified-yellow into semantic status/feedback roles with paired RGB tokens.
- Move AI purple into an AI/agent semantic family; keep Slack colors as feature-local brand tokens.
- Replace `--tint` with named subtle/medium/strong tint roles, and replace `--radius-full` with a
  circle role where `50%` is intentional.
- Give the legacy shadow and transition values semantic effect names, and either add semantic RGB
  companions or use `color-mix()` for future alpha treatments.

### The three escape hatches

1. **File-local tokens** — intentional one-off colors (brand hues, feature accents) go in a `:root`
   block at the top of that feature's CSS file, prefixed with the feature name
   (e.g. `--github-publish-hover-teal` in `features/github.css`). A file-local value still belongs
   to a semantic or component owner; it must not become a second global primitive vocabulary.
2. **`css-ok` tag** — a raw value that genuinely must stay (e.g. backgrounds matching xterm's
   theme) gets a `/* css-ok: reason */` comment on the same line; CI skips tagged lines.
3. **Small local z-index** — within the "content" tier (content-on-content stacking), raw `1`,
   `2`, `5`, `10` are fine. Anything that floats over other UI uses a `--z-*` token.

### Plugin-stable API

`--bg-*`, `--text-*`, `--accent`, `--action`, `--border`, `--warning`, `--success`, `--error`,
`--font-code`, plus the `toolbar-icon-btn` and `button` / `button--*` classes, are public
API for plugins. Renaming any of them is a breaking change (see CLAUDE.md "Shared CSS Classes").

## Primitives

All in [src/components/primitives/](../src/components/primitives/). Plugin-stable `button` and
`toolbar-icon-btn` selectors remain in `base.css`; the rest of the shared primitive selectors have
their own component stylesheet so ownership is visible in the import manifest.

The complete registry is generated in [docs/design-system.generated.md](design-system.generated.md).
It has one row per primitive source file, groups compound exports such as the `Tabs` family, and
records purpose, owner, props/variants, state model, accessibility contract, styling file,
example, tests, and lifecycle. The hand-authored registry source is
[docs/design-system-registry.json](design-system-registry.json); do not edit the generated table.

Hooks that pair with them: `useModalState`,
`useInvoke` / `useAsyncState`, `useCopyToClipboard`, `usePolling` (see CLAUDE.md).

### TextField — [TextField.tsx](../src/components/primitives/TextField.tsx)

`TextField` is the shared native input primitive. Its API intentionally stays small: native input
attributes, `invalid`, and an optional `suffix`. The primitive owns the following visual contract:

| State / density | Contract |
| --- | --- |
| Default | Standard control height, neutral surface, border, tabular control text, and focus ring. |
| Compact | Add `ss-text-field--compact` for dense editor rows; the suffix shell follows the input height. |
| Code | Add `ss-text-field--code` for commands, paths, and other code-like values. |
| Invalid | `invalid` adds the stable invalid class and `aria-invalid="true"`; feature validation owns the message text. |
| Disabled | Native `disabled` behavior remains intact and receives the disabled surface, text, and cursor treatment. |
| Placeholder / focus | Placeholder uses the secondary text role; focus uses the active accent ring and primary text. |
| Labels / help / messages | Render these in the owning form recipe so TextField does not become a form god component. |
| Suffix | `suffix` enables the optional shell; suffix content is decorative/supporting UI, not the input label. |

All TextField typography consumes semantic text roles, and its dimensions consume owner-specific
component tokens backed by the primitive scale. Feature forms should reuse the input shell only
when their state contract matches; `PropertyField` remains reserved for interactive editor values.

### ModalFrame — [ModalFrame.tsx](../src/components/primitives/ModalFrame.tsx)

Overlay + content container + optional header with close button. ESC and click-outside built in,
with managed focus, nested-modal stacking, inert background siblings, and body scroll locking.

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `isOpen` | `boolean` | — | Renders `null` when false. |
| `onClose` | `() => void` | — | Called on ESC / overlay click / close button. |
| `title` | `ReactNode?` | — | Renders a stable `aria-labelledby` target; omit for a headerless dialog. |
| `dismissable` | `boolean` | `true` | `false` disables ESC + overlay dismissal (in-flight destructive ops). |
| `className` | `string?` | — | Appended to the content container for width/tone overrides. |
| `showCloseButton` | `boolean` | `true` | Ignored when no `title`. |
| `ariaLabel` | `string?` | required without `title` | Accessible dialog label; use this for headerless dialogs. |

```tsx
<ModalFrame isOpen={isOpen} onClose={close} title="Rename project">
  {/* body */}
</ModalFrame>
```

Gotchas:

- **Dismissal requires the press to start on the overlay.** A text-selection drag that begins
  inside the modal and releases outside does not close it — don't "fix" this, it protects
  unsaved input.
- Focus enters the requested ref, an `autoFocus` control, the first enabled visible control, or
  the dialog surface. Tab/Shift+Tab stays inside the topmost nested modal, and focus returns to
  the opener when the modal closes (falling back to the next modal/application control if it
  unmounts).
- Component dialog/overlay recipes are scanned across all `src/components` files. Anchored
  popovers and legacy follow-up surfaces must be explicit entries in
  `scripts/check-modal-shells.mjs`; new unreviewed recipes fail `pnpm check:patterns`.
- Open/close state: `useModalState()` for local toggles, `useModal('id')` from `ModalContext`
  for app-registered modals.

### Button family — [Button.tsx](../src/components/primitives/Button.tsx)

Every button control uses one visual recipe and token set while retaining the semantics of its
interaction: `Button` for actions, `IconButton` for icon-only actions, `ToggleButton` for boolean
controls, and `MenuButton` for dropdown triggers.
Use the component matching the behavior instead of flattening different controls into one type.

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `variant` | `'default' \| 'primary' \| 'secondary' \| 'danger' \| 'ghost' \| 'warning' \| 'variable'` | `'default'` | Figma neutral solid, primary, outline, ghost, warning, and variable roles plus the destructive variant. |
| `size` | `'default' \| 'compact' \| 'medium' \| 'large'` | `'default'` | Default is the standard action; compact is reserved for dense rows/toolbars; medium is the smaller control-height option; large is for prominent actions. |
| `width` | `'hug' \| 'fill'` | `'hug'` | Hug contents or fill the available container width. |
| `block` | `boolean?` | — | Backwards-compatible alias for `width="fill"`. |
| `leftIcon` / `rightIcon` | `ReactNode?` | — | Rendered beside children with the standard gap. |

```tsx
<Button variant="primary" leftIcon={<PlusIcon size={14} />} onClick={create}>
  Create project
</Button>

<Button width="fill" onClick={openProject}>
  Open project
</Button>
```

Use `TextButton` for inline prose/metadata actions: it retains native button, ref, disabled, focus,
and icon behavior without a fixed control surface. Use `Tabs` for panel navigation and
`SegmentedControl` for mutually exclusive filters/settings.

`Tabs` defaults to `mode="panel"`: every `TabsList` requires an accessible label, every `TabsTab`
must have a matching `TabsPanel` with the same value, and inactive panels are hidden. Use
`keepMounted` for stateful panel content such as terminals or diagnostic tools; inactive mounted
panels remain inert. Use `mode="navigation"` only when the control changes a route or top-level view
whose content is rendered elsewhere (for example, the workspace Preview/Focus/Code switch); this
mode deliberately omits `aria-controls`. Do not use `Tabs` for an in-place display/filter choice —
use `SegmentedControl`, whose options expose `aria-pressed` state.

Editor values use [PropertyField.tsx](../src/components/primitives/PropertyField.tsx), not
`Button`: `value` and `select` are neutral, while `variable` uses the purple variable tokens.
Inherited and modified state belongs to the field label (orange and blue respectively), so the
value surface itself does not change meaning.

Raw `<button>` elements are reserved for controls whose geometry is the interaction itself, such
as canvas handles, timeline points, colour swatches, rich selection cards, and internals owned by
another primitive. Toolbar actions, icon-only actions, toggles, menu triggers, tabs, segmented
choices, and split actions use the matching family component.

### Spinner — [Spinner.tsx](../src/components/primitives/Spinner.tsx)

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `size` | `'sm' \| 'md' \| 'lg'` | `'md'` | sm = 14px (inline / inside buttons), md = 20px, lg = 32px (section loading). |
| `label` | `string` | `'Loading'` | Screen-reader announcement (`role="status"`). |

```tsx
<Spinner size="sm" />
```

Gotcha: the spinning arc uses `currentColor` — tint it by setting `color` on the spinner
(`style={{ color: 'var(--accent-active)' }}`) or let it inherit; inside a green action button it's
automatically dark. The track stays `var(--border)`.

### PixelLoader — [PixelLoader.tsx](../src/components/primitives/PixelLoader.tsx)

`PixelLoader` is a separate experimental activity indicator; it does not replace or modify
`Spinner`. Its default 5×5 grid contains one centre pixel, an eight-pixel inner ring, and a
sixteen-pixel outer ring, separated by a hairline gap. The `ripple-quad` variant uses a 6×6 grid
with a four-pixel centre, twelve-pixel inner ring, and twenty-pixel outer ring.

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `size` | `'sm' \| 'md' \| 'lg'` | `'md'` | 14px, 20px, or 30px square. |
| `variant` | `'rings' \| 'ripple' \| 'ripple-isolated' \| 'ripple-decay' \| 'ripple-quad' \| 'ripple-quad-tight' \| 'scan' \| 'spark'` | `'ripple'` | Centre-out rings, separated ring beats, overlapping decay, 2×2-core ripples, column scan, or alternating-cell shimmer. |
| `gridSize` | `number` | Variant-dependent | Custom row/column count, clamped from 1–16. Defaults to 5 or 6 for quad variants. |
| `coreSize` | `number` | Variant-dependent | Width and height of the centred core, clamped to the grid. Defaults to 1 or 2 for quad variants. |
| `label` | `string` | `'Loading'` | Screen-reader announcement (`role="status"`). |

```tsx
<PixelLoader variant="ripple" label="Building preview" />
```

All variants animate only light intensity and glow—the pixel grid itself never moves, rotates, or
distorts. `rings` uses the supplied centre-out pulse with fully dimmed cells between light passes.
`ripple-isolated` narrows and separates each ring's bright interval so adjacent rings
overlap less. `ripple-decay` runs faster and retains a mid-glow while the next ring lights, creating
a slight overlap. `ripple-quad-tight` applies that narrower handoff to the 2×2-core geometry.
Reduced-motion users see a static centre-and-rings hierarchy.

### Extension manager contracts

MCP, Skills, and Plugins use the shared structural pieces in
[src/components/plugins/extension/](../src/components/plugins/extension/):
`ExtensionManagerLayout`, `ExtensionSearchField`, `ExtensionListRow`, `ScopeBadge`, and
`ExtensionState`. These components own only stable layout and state semantics; data loading,
filtering rules, and row content remain in each domain manager. Their shared styles live in
`src/styles/features/extensions.css`, while domain styles keep only manager-specific content and
placement.

Terminal visual options follow the same boundary rule in
[terminalTheme.ts](../src/components/terminal/terminalTheme.ts). The typed builder centralizes the
xterm palette and exposes explicit `normal`, `onboarding`, `build`, `logs`, and `connection`
variants. Callers may add lifecycle/input overrides without duplicating visual options.

### Development primitive lab

The development-only primitive lab is a diagnostic surface for Ship Studio's own design-system
contracts. While running the Vite development server, append `?designSystemLab=1` to the app URL.
The lab is query-gated and lazy-loaded only when `import.meta.env.DEV` is true, so it is not a
production route, product feature, or component-catalog experience. It renders real primitives
and their states so contributors can inspect Button variants and sizes, fields, menus, tabs,
overlays, status surfaces, semantic token themes, compact density, keyboard focus, and long or
localized content in one place. Close it from the lab header or remove the query parameter.

Keep the lab separate from any project-facing component catalog: the lab verifies Ship Studio's
own implementation contracts, while a product catalog would document or expose user projects.

### Dropdown — [Dropdown.tsx](../src/components/primitives/Dropdown.tsx)

Menu with open/close state, click-outside, ESC, alignment, and optional portal positioning.
Exports `Dropdown`, `DropdownItem`, `DropdownDivider`.

| Prop (Dropdown) | Type | Default | Notes |
| --- | --- | --- | --- |
| `trigger` | `(props: DropdownTriggerProps) => ReactNode` | — | Spread the props onto your button — they wire toggle, anchor ref, and aria state. |
| `align` | `'left' \| 'right'` | `'left'` | Which trigger edge the menu aligns to. |
| `portal` | `boolean` | `false` | Body portal + fixed positioning. **Use when an ancestor has `overflow: hidden`** (terminal panes, editor panels) that would clip the menu; re-anchors on scroll/resize. |
| `menuClassName` | `string?` | — | Width/feature tweaks on the menu. |
| `onOpenChange` | `(open: boolean) => void?` | — | E.g. lazy-load menu data. |

`DropdownItem`: `onSelect` (menu auto-closes after, unless `keepOpen`), `icon` (size 14 is the
house convention), `variant: 'default' | 'danger'`, `active`, `disabled`.

```tsx
<Dropdown
  align="right"
  trigger={(p) => (
    <MenuButton expanded={p['aria-expanded']} {...p}>
      More
    </MenuButton>
  )}
>
  <DropdownItem icon={<EditIcon size={14} />} onSelect={rename}>Rename</DropdownItem>
  <DropdownDivider />
  <DropdownItem variant="danger" onSelect={remove}>Delete</DropdownItem>
</Dropdown>
```

Gotcha: the trigger click already calls `stopPropagation()` (triggers often sit inside clickable
cards), so don't add your own.

Keyboard contract: opening focuses the first enabled item; Arrow Up/Down, Home/End, disabled-item
skipping, printable-character typeahead, and Enter/Space activation are supported. Escape closes
and restores focus to the trigger. Inputs embedded inside a menu retain their own editing keys.

### ValueField — [ValueField.tsx](../src/components/primitives/ValueField.tsx)

`ValueField` is an editable text input paired with a finite format picker. The format picker is a
select-only `listbox`: opening focuses the selected option, Arrow Up/Down and Home/End move the
active option, Enter/Space selects it, Escape closes and restores the format trigger, and selecting
a format returns focus to the text input. When `variables` are supplied, typing `--`, selecting
`VAR`, or focusing an existing `var(--token)` value opens a filtered variable listbox. The input
shows the raw `--token` name while commits retain the CSS `var(--token)` wrapper.

### EmptyState — [EmptyState.tsx](../src/components/primitives/EmptyState.tsx)

Centered icon / title / description / action stack for empty lists and zero-data panels.

| Prop | Type | Notes |
| --- | --- | --- |
| `title` | `ReactNode` | Required; the headline. |
| `icon` / `description` / `action` | `ReactNode?` | `action` is typically a `<Button>`. |
| `className` | `string?` | Appended for feature spacing tweaks. |

```tsx
<EmptyState icon={<BranchIcon size={24} />} title="No branches yet" action={<Button>New branch</Button>} />
```

### Feature-specific loading placeholders

There is no generic `Skeleton` primitive. Loading placeholders are owned by the feature that knows
the content shape, while feature-specific markup may reuse the shared `skeleton-pulse` keyframes
from `base.css`. Keyframe names are global in CSS, so feature files must not redefine that name;
duplicate keyframes fail CI.

## Enforcement

`pnpm docs:check` compares the registry with every non-test primitive source file and its exported
symbols, checks the Button variant and size unions (including `medium`), validates registry paths,
and confirms the token inventory still points at the canonical token manifest. `pnpm docs:generate`
refreshes [docs/design-system.generated.md](design-system.generated.md) after an intentional
registry or token-source change. The generated inventory includes token-layer counts and sample
names; explanatory guidance in this document remains hand-authored.

[`scripts/check-patterns.sh`](../scripts/check-patterns.sh) (run via `pnpm check:patterns`, part of
`pnpm check:all` in CI) is a deliberately simple grep-based gate against pre-refactor patterns.
It **fails** on: raw color literals in `src/styles` (unless the line is a `--token:` definition or
carries a `/* css-ok: reason */` tag), `var()` references to custom properties defined nowhere
(an undefined var invalidates the declaration and the style silently doesn't apply — this shipped
invisible hover states for months), duplicate `@keyframes` names (global namespace, import-order
roulette), token taxonomy violations (wrong layer direction, duplicate token definitions, manifest
order changes, stale inventory, or new direct primitive consumers), new `onToast?:` prop interfaces
(use `useOptionalToast`), and component dialog/overlay recipes that lack `ModalFrame` or an
explicit allowlist entry. It also prints informational counts for remaining `Result<T, String>`
Rust signatures and raw
`navigator.clipboard` calls. `pnpm check:loc`
([check-loc-limits.sh](../scripts/check-loc-limits.sh)) separately caps file sizes. The full list
of in/out patterns is in [CLAUDE.md → Patterns That Are "Out"](../CLAUDE.md#patterns-that-are-out).

Static inline visual declarations are also governed by `scripts/check-inline-styles.mjs`, which
freezes existing signatures in `scripts/inline-style-baseline.json`. Computed geometry and
platform API values are allowed; new static visual declarations require a token-backed class or a
documented `inline-style-ok` exception.
