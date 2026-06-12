# src/components — Structure Guide

One folder per feature domain. Token + primitive reference: [docs/design-system.md](../../docs/design-system.md).

## Folders

- **`primitives/`** — The design-system building blocks (`ModalFrame`, `Button`, `Spinner`, `Dropdown`, `EmptyState`, `Skeleton`). Generic, feature-agnostic, styled in `src/styles/global/base.css`. Nothing in here may import from feature folders.
- **`icons/`** — Shared SVG icon components, grouped by domain (`brand`, `common`, `editor`, `layout`, `status`, `utility`) and re-exported from `index.tsx`. Add new icons here, not inline in features.
- **`dashboard/`** — The home screen: project grid/list and cards, folders, search/sort, project rail, create-project and template gallery, settings modal, changelog, agents panel, integration bar.
- **`workspace/`** — The open-project shell: header, sidebar, split panes, compact mode, and workspace-scoped modals (env editor, languages, backups, project settings, notifications).
- **`branches/`** — Git branch and PR UI: branches/PR tabs, branch indicator, diff modal, conflict resolution, submit-for-review, publish dropdown, GitHub button.
- **`preview/`** — The live preview pane: browser tools, breakpoint/zoom toolbar pieces, locale switcher, screenshots, and the mobile device mirror (iOS/Android).
- **`terminal/`** — Embedded terminals: the agent PTY terminal, build terminal, dev-server status/logs, dev-command modal.
- **`code/`** — Code mode: file tree, read-only code viewer, and the project health tab panel.
- **`edit/`** — Visual editor internals: the editor panel, element tree, and the property controls (color, length, spacing, enum, opacity, image…).
- **`plugins/`** — Plugin system UI plus the agent-extension modals: plugin manager/slots, skills modal, MCP modal.
- **`setup/`** — First-run onboarding wizard: orchestrator, step indicator, per-step components under `steps/`, onboarding terminal, celebration screen.
- **`shopify/`** — Shopify theme experience: theme setup flow and store-connection modal.
- **`support/`** — In-app support panel: ticket list/form, conversation view, help articles.
- **`CommandPalette/`** — The Cmd+K palette UI, its host, and the palette context. Command *registration* lives in `src/commands/`, not here.
- **`import-project/`** — The GitHub import wizard's `steps/` (account selection, repo selection, workspace picker, progress). The `ImportProject` orchestrator lives in `dashboard/` because it's launched from the dashboard.

## Root-level files

Cross-cutting components mounted at the app level (by `App.tsx` or global hosts), not owned by any single feature view:

- `AppGlobalModals.tsx` — globally-mounted modals that palette commands can open from any view
  (mounts `HelpModal` and `dashboard/ChangelogModal` — a modal can live in a feature folder and
  still be globally mounted here)
- `ConnectOverlay.tsx` — full-tab "connect GitHub" gate shown when a feature needs auth
- `EducationOverlay.tsx` — Education Mode x-ray overlay (hover any UI element to learn it)
- `ErrorBoundary.tsx` — top-level crash recovery, including plugin-crash attribution/uninstall
- `HelpModal.tsx` — slash-command glossary, shortcuts, and tips (openable from anywhere)
- `UpdateBanner.tsx` — auto-update available/progress banner

## Where does my new component go?

Owned by one feature view → that feature's folder. Generic and reusable across features →
`primitives/` (and document it in `docs/design-system.md`). An SVG icon → `icons/`. Mounted
globally across views → root level (rare; think twice). A modal → the folder of the feature
that opens it, built on `<ModalFrame>`.
