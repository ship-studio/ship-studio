# CSS ownership and load order

This is the ownership baseline for Ship Studio's application styles. The executable inventory is
`scripts/check-css-ownership.mjs`; run `pnpm exec node scripts/check-css-ownership.mjs --report` to
print the current stylesheet-by-stylesheet ownership table, including the importer, selector
policy, and load-order dependency. The check runs as part of `pnpm check:patterns` and fails on
duplicate manifest/module ownership, missing local stylesheet imports, or the retired generic
`.hint` selector.

## Ownership model

`src/styles/index.css` is the application manifest while the migration is staged. It owns fonts,
tokens, reset/plugin-stable rules, shared primitives, and feature styles that have not yet moved to
an importing module. Primitive and feature families are split into named files in the manifest so
the load order remains explicit. A stylesheet removed from the manifest must be imported by the
component or feature entry point that owns its rendered markup.

| Style category | Current owner | Selector policy | Load-order rule |
| --- | --- | --- | --- |
| `src/styles/global/fonts.css` | `src/styles/index.css` | Font-face declarations | Load before all rules that consume the families. |
| `src/styles/global/tokens-*.css` | `src/styles/index.css` | Token definitions only | Preserve the order in `token-manifest.json`; semantic roles may reference primitives. |
| `src/styles/global/base.css` | `src/styles/index.css` | Reset, shared keyframes, plugin-stable classes, and global app rules | Load after tokens and before component/feature rules. |
| `src/styles/global/typography.css` | `src/styles/index.css` | Shared typography helper selectors | Load after tokens and `base.css`, before component/feature rules. |
| `src/styles/components/{modal-frame,property-field,text-field,dropdown,empty-state,spinner,pixel-loader}.css` | `src/styles/index.css` | Named primitive selectors | Load after `base.css`; each file owns the matching primitive contract. |
| `src/styles/components/*.css` | `src/styles/index.css` during migration | Shared primitive/component selectors | Keep after global rules until each remaining primitive has an explicit owner. |
| `src/styles/features/visual-editor/{panel,controls,usage,properties}.css` | `src/styles/index.css` | Visual-editor control-family selectors | Preserve this order: panel shell → enum/color controls → usage/source surfaces → property/box-model controls. |
| `src/styles/features/settings-forms.css` | ProjectSettingsModal, DevCommandModal | Shared settings form recipe; feature classes remain semantic (`project-settings-*`, `dev-command-*`) | Load after the general settings feature styles and before consumers render their modal content. |
| `src/styles/features/extensions.css` | McpModal, SkillsModal, PluginManager | Shared extension-manager layout, search field, list row, scope badge, and loading/empty/error state contracts | Load before the domain extension styles so feature-specific placement can override the shared shell. |
| `src/styles/features/design-system-lab.css` | `src/components/design-system/DesignSystemLab.tsx` | Development-only primitive lab surface; all selectors are scoped under `.ss-design-system-lab` | Module import controls the load point; the lazy entry is query-gated and never loaded in production. |
| `src/styles/features/*.css` | `src/styles/index.css` during migration | Domain selectors; review for global leakage | Preserve manifest order until a domain is migrated and its state matrix is checked. |
| `src/styles/features/update-banner.css` | `src/components/UpdateBanner.tsx` | Update-banner selectors | Module import controls its load point; it is no longer in the global manifest. |
| `src/styles/features/account-select.css` | AccountSelectScreen, AccountSettingsModal, WorkspaceSidebar | Account/workspace selectors | Module imports control load point. |
| `src/styles/features/main-branch-banner.css` | `src/components/branches/MainBranchBanner.tsx` | Branch-banner selectors | Module import controls load point. |
| `src/styles/features/notifications.css` | NotificationSettingsModal, WorkspaceView | Notification selectors only | Keep notification-specific shell, toggle, and sound-picker rules out of unrelated settings forms. |
| `src/styles/features/stale-env-banner.css` | `src/components/terminal/StaleEnvBanner.tsx` | Stale-environment selectors | Module import controls load point. |
| `src/styles/modes/*.css` | `src/styles/index.css` during migration | Mode-scoped selectors | Keep after feature rules until mode ownership is migrated. |

## First migration checkpoint

`update-banner.css` was the first duplicate ownership case. Its import remains next to the
`UpdateBanner` implementation, and the matching entry was removed from `src/styles/index.css`.
The module-owned import is intentionally kept close to the markup so future changes cannot silently
depend on the manifest's position.

The generic `.hint` selector was replaced by the named `.text-style-hint` typography helper. Contexts
that need different spacing or scale now scope those adjustments through their domain selectors,
while the shared text treatment remains semantic and token-backed.

## Migration rule

Before moving the next stylesheet, record its importer, selector policy, and order dependency with
the report command. If a visual or state difference depends on equal-specificity import order,
document that dependency and keep the stylesheet in the manifest until the competing selectors are
scoped or consolidated. Do not add new generic selectors to compensate for a migration.

## Inline-style policy

Static visual declarations belong in token-backed CSS classes. `scripts/check-inline-styles.mjs`
freezes the existing static inline-style signatures in `scripts/inline-style-baseline.json` and
fails when a new static signature is introduced. This is a delta check, so existing work can be
migrated incrementally without making unrelated cleanup a prerequisite.

Allowed inline values are computed geometry (for example measured `top`, `left`, `width`, or
`height`) and platform API annotations such as `WebkitAppRegion`. A genuine non-geometry exception
must carry an adjacent `/* inline-style-ok: reason */` comment. New colors, surfaces, borders,
typography, spacing, shadows, and z-index values must use a class and the primitive → semantic →
component token layers.
