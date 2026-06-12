# Ship Studio Design System

The reference for tokens and UI primitives. Audience: you're about to build a feature and need
the right token or component in under a minute. Canonical sources (always trust these over docs):

- Tokens: the `:root` block at the top of [src/styles/global/base.css](../src/styles/global/base.css)
- Primitives: [src/components/primitives/](../src/components/primitives/)
- The rules and rationale: [CLAUDE.md → How to Do Things in Ship Studio](../CLAUDE.md#how-to-do-things-in-ship-studio)
  and [docs/CONTRIBUTING_PATTERNS.md](CONTRIBUTING_PATTERNS.md)

## Design tokens

All defined in the `:root` block of `base.css`. Never write raw hex colors, raw spacing px, raw
z-index numbers, or raw durations in CSS — use a token (CI enforces colors; review enforces the rest).

| Group | Tokens | When to use |
| --- | --- | --- |
| Surfaces | `--bg-primary` / `--bg-secondary` / `--bg-tertiary`, `--bg-deep` | App background → panels → raised elements; `--bg-deep` for recessed wells (terminals, log output, code editors). |
| Text | `--text-primary` / `--text-secondary` / `--text-muted`, `--text-bright` | Default → secondary labels → disabled/hints; `--text-bright` (pure white) only for high-emphasis text/icons. |
| Brand / interactive | `--accent(-hover)`, `--action(-hover)`, `--action-text` | `--accent` is the white brand accent (active/selected); `--action` is the green CTA color, always paired with `--action-text` for legible dark text on it. |
| Status | `--success(-light)`, `--warning(-light)`, `--error(-light)`, `--error-deep`, `--modified-yellow` | Semantic states. `-light` variants for tinted backgrounds/pills, `--error-deep` for armed destructive states, `--modified-yellow` for git-modified badges. |
| Info blue | `--info(-hover/-light/-dark)` | Links, info banners, "open" PR state, focus accents. |
| Purple | `--purple`, `--purple-light`, `--purple-deep-rgb` | AI / agent surfaces only (skills, MCP, plugin marketplace). |
| Slack | `--slack-pink`, `--slack-lavender(-bright)` | Slack community CTA branding only (dashboard, setup, support panel). |
| RGB triplets | `--*-rgb` (e.g. `--error-rgb: 244, 71, 71`) | For alpha tints only: `rgba(var(--error-rgb), 0.1)`. Each must stay in sync with its solid token. |
| Tints | `--tint-subtle` / `--tint` / `--tint-strong` | White hover/selection washes on dark surfaces (5/8/10% white). |
| Overlays | `--overlay-30` … `--overlay-80` | Black scrims behind modals, image dimming. Suffix = alpha %. |
| ANSI palette | `--ansi-green/red/yellow/blue(-dark)` (+ `-rgb`) | Terminal-flavored output: health diagnostics, browser tools, log rendering. Not for general UI status — that's the status group. |
| Code syntax | `--code-keyword/string/property/comment` | VS Code dark syntax colors for code mode and diff rendering. |
| Structure / hover | `--border`, `--bg-hover`, `--border-hover` | Borders and the standard hover pair for list rows / tabs / bordered cards. |
| Spacing | `--spacing-xs` … `--spacing-2xl` (4–32px) | All padding, margin, gap. |
| Radius | `--radius-sm` (4) / `--radius` (6) / `--radius-md` (8) / `--radius-lg` (12) / `--radius-full` | Corner rounding; `--radius-full` for circles. |
| Z-index tiers | `--z-dropdown` (100) → `--z-preview-fullscreen` (900) → `--z-modal-overlay/-modal` (1000/1001) → `--z-tooltip` (1100) → `--z-notification` (1200) → `--z-app-*` / `--z-toast*` (9999–10010) | Pick the tier, not a number: floating menus < fullscreen preview < modals < tooltips < toasts < global app overlays. (`--z-changelog-sentinel` is the deliberate ceiling.) |
| Layout dims | `--editor-panel-w`, `--preview-toolbar-h`, `--tree-panel-w` | Shared panel dimensions that must agree across files (and with `PANEL_WIDTH` in `VisualEditorPanel.tsx`). |
| Shadows | `--shadow-sm` / `--shadow` / `--shadow-md` / `--shadow-lg` | Elevation: small popovers → dropdowns → modals → fullscreen layers. |
| Transitions | `--transition-fast` (0.1s) / `--transition` (0.15s) / `--transition-slow` (0.3s) | Duration + easing bundled: `transition: background var(--transition)`. |
| Type scale | `--font-size-xs` (10) … `--font-size-3xl` (24); `--font-mono` | Dense desktop UI, 1px steps at the small end. Off-scale sizes (9/15/17px…) are migration debt — round to the nearest token when touching that code. `--font-mono` for terminal/code. |

Need a value that doesn't exist? Add the token to `:root` in `base.css` first, then use it.

### The three escape hatches

1. **File-local tokens** — intentional one-off colors (brand hues, feature accents) go in a `:root`
   block at the top of that feature's CSS file, prefixed with the feature name
   (e.g. `--github-publish-hover-teal` in `features/github.css`).
2. **`css-ok` tag** — a raw value that genuinely must stay (e.g. backgrounds matching xterm's
   theme) gets a `/* css-ok: reason */` comment on the same line; CI skips tagged lines.
3. **Small local z-index** — within the "content" tier (content-on-content stacking), raw `1`,
   `2`, `5`, `10` are fine. Anything that floats over other UI uses a `--z-*` token.

### Plugin-stable API

`--bg-*`, `--text-*`, `--accent`, `--action`, `--border`, `--warning`, `--success`, `--error`,
`--font-mono`, plus the `toolbar-icon-btn` / `btn-primary` / `btn-secondary` classes, are public
API for plugins. Renaming any of them is a breaking change (see CLAUDE.md "Shared CSS Classes").

## Primitives

All in [src/components/primitives/](../src/components/primitives/), styled in `base.css` under
`/* ===== Primitive: … ===== */` sections. Hooks that pair with them: `useModalState`,
`useInvoke` / `useAsyncState`, `useCopyToClipboard`, `usePolling` (see CLAUDE.md).

### ModalFrame — [ModalFrame.tsx](../src/components/primitives/ModalFrame.tsx)

Overlay + content container + optional header with close button. ESC and click-outside built in.

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `isOpen` | `boolean` | — | Renders `null` when false. |
| `onClose` | `() => void` | — | Called on ESC / overlay click / close button. |
| `title` | `ReactNode?` | — | Omit entirely to render headerless. |
| `dismissable` | `boolean` | `true` | `false` disables ESC + overlay dismissal (in-flight destructive ops). |
| `className` | `string?` | — | Appended to the content container for width/tone overrides. |
| `showCloseButton` | `boolean` | `true` | Ignored when no `title`. |
| `ariaLabel` | `string?` | falls back to string `title` | Accessible dialog label. |

```tsx
<ModalFrame isOpen={isOpen} onClose={close} title="Rename project">
  {/* body */}
</ModalFrame>
```

Gotchas:

- **Dismissal requires the press to start on the overlay.** A text-selection drag that begins
  inside the modal and releases outside does not close it — don't "fix" this, it protects
  unsaved input.
- CI checks that every `*Modal.tsx` file imports `ModalFrame` (`check-patterns.sh` rule 5).
- Open/close state: `useModalState()` for local toggles, `useModal('id')` from `ModalContext`
  for app-registered modals.

### Button — [Button.tsx](../src/components/primitives/Button.tsx)

The standalone action button. Extends `ButtonHTMLAttributes` (so `onClick`, `disabled`, `title`,
… all pass through), forwards its ref, defaults `type="button"`.

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `variant` | `'primary' \| 'secondary' \| 'danger' \| 'ghost'` | `'secondary'` | primary = green CTA (one per view); secondary = outlined neutral; danger = red-tinted destructive; ghost = borderless low-emphasis. |
| `size` | `'sm' \| 'md'` | `'md'` | `sm` for dense rows/toolbars. |
| `block` | `boolean?` | — | Full width. |
| `leftIcon` / `rightIcon` | `ReactNode?` | — | Rendered beside children with the standard gap. |

```tsx
<Button variant="primary" leftIcon={<PlusIcon size={14} />} onClick={create}>
  Create project
</Button>
```

When a raw `<button>` is legitimate — the canonical list lives in
[CLAUDE.md → "When a raw `<button>` is fine"](../CLAUDE.md#new-button--use-button-variant-from-srccomponentsprimitivesbuttontsx).
Summary: `toolbar-icon-btn` chrome, icon-only buttons ≤ 28px, toggles/segmented controls/tabs,
dropdown triggers, internals of other primitives, and intentionally brand-colored CTAs.

### Spinner — [Spinner.tsx](../src/components/primitives/Spinner.tsx)

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `size` | `'sm' \| 'md' \| 'lg'` | `'md'` | sm = 14px (inline / inside buttons), md = 20px, lg = 32px (section loading). |
| `label` | `string` | `'Loading'` | Screen-reader announcement (`role="status"`). |

```tsx
<Spinner size="sm" />
```

Gotcha: the spinning arc uses `currentColor` — tint it by setting `color` on the spinner
(`style={{ color: 'var(--accent)' }}`) or let it inherit; inside a green action button it's
automatically dark. The track stays `var(--border)`.

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
<Dropdown align="right" trigger={(p) => <button className="toolbar-icon-btn" {...p}>•••</button>}>
  <DropdownItem icon={<EditIcon size={14} />} onSelect={rename}>Rename</DropdownItem>
  <DropdownDivider />
  <DropdownItem variant="danger" onSelect={remove}>Delete</DropdownItem>
</Dropdown>
```

Gotcha: the trigger click already calls `stopPropagation()` (triggers often sit inside clickable
cards), so don't add your own.

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

### Skeleton — [Skeleton.tsx](../src/components/primitives/Skeleton.tsx)

Pulsing placeholder while content loads.

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `variant` | `'text' \| 'card' \| 'grid'` | `'text'` | text = 12px line, card = 96px block, grid = auto-fill grid of cards. |
| `count` | `number` | `1` | Renders that many siblings (or grid cells). |
| `width` / `height` | `number \| string?` | — | Inline size overrides; ignored by `grid`. |
| `className` / `style` | — | — | Pass-through. |

```tsx
<Skeleton variant="grid" count={6} />
```

Gotcha: the `skeleton-pulse` keyframes live in `base.css` only — keyframe names are global in
CSS, and a feature-file duplicate silently overrides every consumer (this happened; CI now fails
duplicates).

## Enforcement

[`scripts/check-patterns.sh`](../scripts/check-patterns.sh) (run via `pnpm check:patterns`, part of
`pnpm check:all` in CI) is a deliberately simple grep-based gate against pre-refactor patterns.
It **fails** on: raw color literals in `src/styles` (unless the line is a `--token:` definition or
carries a `/* css-ok: reason */` tag), `var()` references to custom properties defined nowhere
(an undefined var invalidates the declaration and the style silently doesn't apply — this shipped
invisible hover states for months), duplicate `@keyframes` names (global namespace, import-order
roulette), new `onToast?:` prop interfaces (use `useOptionalToast`), and `*Modal.tsx` files that
don't import `ModalFrame`. It also prints informational counts for remaining `Result<T, String>`
Rust signatures and raw `navigator.clipboard` calls. `pnpm check:loc`
([check-loc-limits.sh](../scripts/check-loc-limits.sh)) separately caps file sizes. The full list
of in/out patterns is in [CLAUDE.md → Patterns That Are "Out"](../CLAUDE.md#patterns-that-are-out).
