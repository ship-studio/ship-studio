# src/components — Structure Guide

One folder per feature domain. Token + primitive reference: [docs/design-system.md](../../docs/design-system.md).

## Folders

- **`primitives/`** — The design-system building blocks (`Button`, `IconButton`, `ToggleButton`, `MenuButton`, `ModalFrame`, `Dropdown`, `TextField`, `ValueField`, `PropertyField`, `Tabs`, `SegmentedControl`, `TextButton`, `DockablePanel`, `PanelResizeHandle`, `EmptyState`, `Spinner`, `PixelLoader`, `ToastList`, `Tooltip`, and `MiddleTruncate`). The complete registry is generated from [docs/design-system-registry.json](../../docs/design-system-registry.json) into [docs/design-system.generated.md](../../docs/design-system.generated.md), and drift is checked by `pnpm docs:check`. Generic, feature-agnostic primitives must not import from feature folders. Plugin-stable button selectors remain in `src/styles/global/base.css`; other primitive styles live in their named files under `src/styles/components/` or their explicitly documented feature owner.
- **`icons/`** — Semantic SVG icon components grouped by domain (`brand`, `common`, `editor`, `editor-controls`, `layout`, `status`, `utility`) and re-exported from the public `index.tsx` barrel. Feature code imports icons from `@/components/icons`; the modules own asset imports and metadata, while `src/assets/icons/` and `src/assets/icons/old-icons/` own the SVG files. Feature-specific artwork belongs in `src/assets/graphics/` and stays with the consuming feature rather than entering the shared barrel. Static inline SVG is not used in feature components; `BranchGraph.tsx` is the marked dynamic exception.
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
- `UpdateBanner.tsx` — sidebar update indicator and release-specific update modal

## Where does my new component go?

Owned by one feature view → that feature's folder. Generic and reusable across features →
`primitives/` (and document it in `docs/design-system.md`). An SVG icon → `icons/`. Mounted
globally across views → root level (rare; think twice). A modal → the folder of the feature
that opens it, built on `<ModalFrame>`. The development-only primitive lab is under
`components/design-system/`; it is query-gated and is not a product component catalog.
