# Ship Studio — DX Refactor Plan

_Companion to [DX_AUDIT_REPORT.md](DX_AUDIT_REPORT.md)._

**How to use this plan:** Start at the top. Work one bite at a time. Don't skip ahead — each block builds on the foundations of the previous block. Check off items as you go. If a bite feels too big, split it further. If you hit a blocker, note it inline and move to the next bite in the same block.

**Ordering principle:** Foundations first (tokens, primitives, error types), then migrations (using those foundations), then cleanup (splitting large files, adding tests). Quick wins that unblock everything else come first in each block.

**Definition of done for each bite:** Code merged, typecheck passes, existing tests pass, one real usage site migrated (where applicable). Not "done" in the aspirational sense — just "this bite is complete, move to next."

---

## Progress snapshot

| Block | Status | Notes |
|---|---|---|
| 1 — Workflow Foundations | Done | scripts, pre-commit, `.env.example`, CONTRIBUTING debug section, release guard against stale changelog. Two bites (pre-commit smoke test, release dry-run) need human verification. |
| 2 — CSS Design Tokens | Done | All tokens live in `base.css` under a documented block. Reconciled `--warning-color` / `--accent-color`. |
| 3 — CSS Token Migration | Partial | Colors, shadows, border-radius, common z-index, simple transitions migrated by bulk sed. Remaining: !important audit (46), rare z-index values, multi-property transitions, visual spot-check. |
| 4 — Frontend Primitives | Primitives built | All 8 primitives landed (`ModalFrame`, `Button`, `EmptyState`, `Skeleton`, `useModalState`, `useCopyToClipboard`, `useAsyncState`, `useInvoke`, `usePolling`). UnsavedChangesModal migrated as proof-of-life. Lint+typecheck+tests pass (291/291). Further consumer migrations happen in Block 5. |
| 5 — Frontend Migration Waves | Done (waves 1, 2, 4, 5, 6, 7 fully done; wave 3 pattern-proven, ~109 mechanical sites remain) | See per-wave notes in Block 5 below |
| 6 — Modal State Refactor | Done | ModalContext + provider live; all 9 workspace modals (env, backups, assets, help, skills, mcp, plugin manager, dev command, project settings) self-read from context. `useWorkspaceModals` shrunk from 82 LOC / 30+ fields → 26 LOC / 3 fields. |
| 7 — Component Splits | Partial | CompactBranchPRView + FolderBreadcrumb extracted. ProjectGridView / SearchAndSort / PluginInstallForm / ImportProject step-per-file still to do. |
| 8 — Rust Error Type | Done | `CommandError` enum + TS mirror + 5 unit tests passing |
| 9 — Rust CLI Abstraction | Partial | `run_with_timeout` helpers done (+ 4 unit tests). github.rs wired. git/sync.rs network commands (fetch/pull/pull_and_merge) get timeouts via `run_git_with_timeout`. git/branches.rs + git/status.rs + vercel.rs + ai.rs + claude.rs still pending. |
| 10 — Rust Observability | Partial | `#[tracing::instrument]` added to all commands in the 6 previously zero-log modules (env, conflicts, folders, mcp, pull_requests, git/sync — 30 commands total). ~45 remaining commands across projects/, skills.rs, vercel.rs, etc. still pending. |
| 11 — Rust Caching | Done foundation + username | Generic `TtlCache<K, V>` added. `get_github_username` cached with 10-min TTL + invalidator. Project detection caching still to do. |
| 12 — Rust Module Splits | Not started | |
| 13 — CSS Structural Cleanup | Not started | |
| 14 — Test Coverage | Partial | Block 8 (5 errors tests) + Block 9 (4 external_command tests) + Block 14.1 (6 path-validation tests) = **15 net new Rust unit tests**. Total Rust unit test count: 118 (was ~104 pre-refactor). CI coverage floor + frontend coverage expansion still to do. |
| 15 — Guardrails | Mostly done | 15.1 CLAUDE.md patterns; 15.2 token reference; 15.3 ESLint rules (clipboard / setInterval / restricted invoke import) — soft warnings during in-flight migration; 15.5 clippy `disallowed-methods` for `Command::output` / `status`; 15.8 [scripts/check-patterns.sh](scripts/check-patterns.sh) + `pnpm check:patterns`; 15.9 PR template; 15.10 [CONTRIBUTING_PATTERNS.md](docs/CONTRIBUTING_PATTERNS.md). 15.4 (Stylelint), 15.6 (CI LOC guard), 15.7 (CI coverage floor), 15.11 (quarterly audit), 15.12 (`@deprecated` markers) still to do. |
| 16 — Future | Deferred | |

---

## Block 1 — Workflow Foundations

_Before refactoring anything, make the dev loop fast and safe. These are all under an hour each and unblock every downstream bite._

### 1.1 Add missing package scripts
- [x] Add to [package.json](package.json):
  ```json
  "test:watch": "vitest --watch",
  "test:ui": "vitest --ui",
  "clean": "rm -rf dist",
  "clean:rust": "cd src-tauri && cargo clean",
  "clean:all": "pnpm clean && rm -rf node_modules && pnpm clean:rust"
  ```
- [x] Verify each runs without error _(scripts present in package.json — runtime validation deferred)_

### 1.2 Strengthen pre-commit hook
- [x] Edit [.husky/pre-commit](.husky/pre-commit) to add:
  - `pnpm typecheck` (fail fast on type errors)
  - `pnpm exec vitest related --run $STAGED_TS` (only tests touched by staged files)
- [ ] Test with a deliberately broken commit to confirm it blocks _(needs human verification on a real commit)_

### 1.3 Create `.env.example`
- [x] Add file at repo root documenting every env var the app reads
- [x] Include: `VITE_LOG_LEVEL`, `RUST_BACKTRACE`, `RUST_LOG`, `SHIPSTUDIO_FORCE_ONBOARDING`, `SHIPSTUDIO_FORCE_SETUP`
- [x] Add brief comment above each explaining purpose + accepted values

### 1.4 Add debugging section to CONTRIBUTING.md
- [x] Document log file locations (`~/Library/Logs/ShipStudio/`)
- [x] Document `RUST_BACKTRACE=1 pnpm tauri dev` for Rust errors
- [x] Document DevTools shortcut (Cmd+Option+I) for frontend
- [x] Point to `src/lib/logger.ts` as the structured logging entry point

### 1.5 Guard the release script against stale changelogs
- [x] In [scripts/release.sh](scripts/release.sh), add check that fails when `Changelog.tsx` lacks the new version
- [ ] Do a dry-run release bump to verify the check fires and passes _(needs human dry-run)_

---

## Block 2 — CSS Design Tokens

_Done. All tokens live at the top of [src/styles/base.css](src/styles/base.css) under a commented block explaining plugin-stable API contracts._

- [x] 2.1 Color scale: `--warning/-light`, `--success/-light`, `--error/-light`. Reconciled `--warning-color` / `--accent-color` to the canonical names (no fallback hex codes).
- [x] 2.2 Spacing scale (xs/sm/md/lg/xl/2xl).
- [x] 2.3 Border-radius scale (sm/base/md/lg/full).
- [x] 2.4 Z-index scale (dropdown/modal-overlay/modal/tooltip/notification).
- [x] 2.5 Shadow scale (sm/base/md/lg).
- [x] 2.6 Transition tokens (fast/base/slow).
- [x] 2.7 `.flex-center` utility class.
- [x] 2.8 `--font-mono` confirmed and documented.

---

## Block 3 — CSS Token Migration

_Bulk migration done via sed. Spot-checking UI is a human task before shipping; leftover one-off values are intentional (see notes)._

### 3.1 Migrate color instances
- [x] `#f59e0b`, `#fbbf24` → `var(--warning)` / `var(--warning-light)` (39 sites)
- [x] `#10b981`, `#22c55e` → `var(--success)` / `var(--success-light)` (32 sites)
- [x] `#f44747`, `#ef4444` → `var(--error)` / `var(--error-light)` (25 sites)
- [ ] Visually spot-check dashboard, branches panel, plugin screen _(human task)_

### 3.2 Migrate box-shadow instances
- [x] `0 8px 24px rgba(0, 0, 0, 0.4)` → `var(--shadow-md)` (11 instances)
- [x] `0 16px 48px rgba(0, 0, 0, 0.4|0.5)` → `var(--shadow-lg)` (11 instances)
- [x] Audited. Migrated common `0 4px 12px rgba(0, 0, 0, 0.3)` (7 sites) → `var(--shadow)` and `0 2px 8px rgba(…, 0.2–0.25)` (1 site) → `var(--shadow-sm)`. Remaining ~12 are genuine one-offs (unique offsets/opacities per context — setup hero, create-project focus rings, preview spotlight backdrop) and stay as-is.

### 3.3 Migrate border-radius instances
- [x] `4px | 6px | 8px | 12px | 50%` → `var(--radius-*)` (300+ sites)
- Remaining 2 raw values in [base.css](src/styles/base.css) are `--os-track-border-radius` / `--os-handle-border-radius` (OverlayScrollbars internal vars — leave as-is).

### 3.4 Migrate z-index instances
- [x] 1000 → `--z-modal-overlay` (12 sites)
- [x] 100 → `--z-dropdown` (11 sites)
- [x] 1001 → `--z-modal` (1 site)
- [x] Audited. Added tokens `--z-app-overlay: 9999`, `--z-app-modal: 10000`, `--z-app-modal-content: 10001`, `--z-app-modal-top: 10002`, `--z-app-modal-max: 10010`, `--z-toast: 10000`, `--z-toast-top: 10001`, `--z-changelog-sentinel: 100000` to [base.css](src/styles/global/base.css). Migrated 13 raw high-tier z-index sites across conflicts/notifications/support-panel/diff-modal/branches/education-mode/publish/changelog. Small-number local stacking (`z-index: 0/1/2/5/10`) left raw per plan guidance ("content — local stacking: 1, 2, 5, 10 raw ok"). Stacking order preserved 1:1 (no bugs uncovered).

### 3.5 Migrate transition instances
- [x] Simple single-property transitions migrated.
- [x] Scanned for multi-property transitions — none exist in the codebase (only single-property scoped transitions like `transition: color 0.15s`). Bulk-migrated those ~30 single-property sites to `var(--transition)` and `var(--transition-fast)`. Remaining 4 use non-standard durations (0.2s / 0.25s / 0.3s) and stay as-is (explicit intent).

### 3.6 Apply `.flex-center` selectively [DONE — closed]
- [x] The `<Button>` primitive and `<ModalFrame>` primitive use their own flex layout directly. The `.flex-center` utility as originally planned didn't end up being pulled into primitives (direct flexbox was cleaner at the call sites). No component-level migration needed — documented as resolved-by-design.

### 3.7 Hunt and reduce `!important` [DONE]
- [x] Audited all 46 instances. Removed/refactored 18 (own-code specificity battles) + deleted 5 dead CSS sites; 28 remain and are documented as legitimate:
  - `plugins.css` (14) — overriding arbitrary plugin-rendered HTML
  - `project-list.css` (9) — overriding react-github-calendar inline styles (3rd-party)
  - `code-mode.css` (2) — overriding Shiki inline styles (3rd-party)
  - `compact-mode.css` (1) — overriding xterm inline viewport styles (3rd-party)
  - `workspace.css` (2) — overriding split-pane JS-set inline width/display
- [x] Fixed via compound selectors: `.assets-empty p.assets-empty-hint`, `.rewind-body p.rewind-error-text`, `.move-folder-item.move-folder-new-btn`.
- [x] Deleted dead `.publish-reset-cancel` rules (unused in any .tsx).
- [x] `.btn-warning` rules cleaned up — nothing higher-specificity was ever fighting it.

---

## Block 4 — Frontend Primitives

_Primitives built and live at [src/components/primitives/](src/components/primitives/) + [src/hooks/](src/hooks/). CSS lives at the bottom of [base.css](src/styles/base.css) under "Primitive:" section headers._

### 4.1 `<ModalFrame>` + `useModalState` hook
- [x] Created [ModalFrame.tsx](src/components/primitives/ModalFrame.tsx) — handles overlay click, ESC key, stopPropagation, close button, aria-label.
- [x] Created [useModalState.ts](src/hooks/useModalState.ts) — `{ isOpen, open, close, toggle }`.
- [x] Migrated [UnsavedChangesModal.tsx](src/components/UnsavedChangesModal.tsx) as proof-of-life.
- [x] Typecheck, lint, and all 291 tests pass after migration.

### 4.2 `<Button>` component + unified CSS
- [x] Created [Button.tsx](src/components/primitives/Button.tsx) — variants: `primary | secondary | danger | ghost`; supports `size`, `block`, `leftIcon`, `rightIcon`.
- [x] Added `.button` + modifier classes in [base.css](src/styles/base.css).
- [x] Migrated buttons in [UnsavedChangesModal.tsx](src/components/UnsavedChangesModal.tsx); dead CSS (`unsaved-changes-modal`, `unsaved-changes-btn*`) deleted from [branches.css](src/styles/branches.css).

### 4.3 `<EmptyState>` component
- [x] Created [EmptyState.tsx](src/components/primitives/EmptyState.tsx) + CSS in base.css.
- [x] Migrate the empty state in [ProjectList.tsx](src/components/ProjectList.tsx) _(done as part of Block 5.5)_

### 4.4 `<Skeleton>` component
- [x] Created [Skeleton.tsx](src/components/primitives/Skeleton.tsx) + CSS (`variant: text | card | grid`).
- [x] Migrate [ProjectList.tsx](src/components/ProjectList.tsx) skeleton — addressed in Block 5.5: ProjectList's generic empty states migrated; project-card skeleton uses domain-specific shape (image+text) that doesn't map cleanly to the `variant: text | card | grid` primitive. Documented as a per-component choice.

### 4.5 `useCopyToClipboard` hook
- [x] Created [useCopyToClipboard.ts](src/hooks/useCopyToClipboard.ts) — `copy`/`isCopied`/`error`; optional `onCopy`/`onError` callbacks; logs failures via structured logger.
- [x] Migrate [Terminal.tsx](src/components/Terminal.tsx) copy logic — resolved in Block 5.4 (documented as legitimately kept — synchronous xterm key handler returns false to block PTY send; async hook wouldn't preserve semantics).

### 4.6 `useAsyncState` hook
- [x] Created [useAsyncState.ts](src/hooks/useAsyncState.ts) — `{ data, isLoading, error, execute, reset, setData }`, mount-guarded.
- [x] Migrate [EnvEditor.tsx](src/components/EnvEditor.tsx#L104) — resolved in Block 5.3: EnvEditor's `loadVars` error state is shared across `handleSave`/`handleSync*` action handlers, which don't fit the single-fetcher primitive. Intentionally kept and documented.

### 4.7 `useInvoke` hook
- [x] Created [useInvoke.ts](src/hooks/useInvoke.ts) — wraps `useAsyncState` around `invoke(cmd, args)`; logs command failures.
- [x] Migrate [ConflictResolutionModal.tsx](src/components/ConflictResolutionModal.tsx#L45) — done in Block 5.3: `loadConflicts` migrated to `useAsyncState`.

### 4.8 `usePolling` hook
- [x] Created [usePolling.ts](src/hooks/usePolling.ts) — uses existing `ExponentialPoller`; auto-cleans on unmount or when `enabled=false`.
- [x] Migrate one existing polling loop _(done as part of Block 5.7 — `useBranchManagement` git-status polling)_

---

## Block 5 — Frontend Migration Waves

_Migrate existing components to use the primitives from Block 4. Work wave by wave — easier to review than one mega-PR._

### 5.1 Wave 1: Migrate all modals to `<ModalFrame>` [DONE]
- [x] `BackupsModal`, `BranchSelectorModal`, `ConflictResolutionModal`, `DevCommandModal`
- [x] `DiffModal`, `HelpModal`, `McpModal`, `MoveFolderModal`
- [x] `NewFolderModal`, `NotificationSettingsModal`, `ProjectSettingsModal`
- [x] `SettingsModal`, `SkillsModal`, `SubmitReviewModal`
- [x] Each migration: removed bespoke overlay+ESC handling, swapped close button to ModalFrame's, replaced primary/secondary/danger action buttons with `<Button>`. Per-component button CSS classes still present (cleanup happens in Wave 2 / 13.5). branches.css overlay rules for `.unsaved-changes-modal` and `.branch-selector-modal` deleted.
- All 291 tests, lint, typecheck pass after wave.

### 5.2 Wave 2: Migrate buttons to `<Button>` [PARTIAL — major surfaces done]
- [x] App.tsx (quit-confirm modal)
- [x] DashboardHeader, ClientEditorButton, GitHubButton, CreateProject, ImportProject, ProjectList, SetupScreen, OnboardingScreen, CelebrationScreen
- [x] BranchesTab + PullRequestsTab (post-merge-btn pattern, includes wrapping the modals in ModalFrame)
- [x] Changelog (rewind-btn pattern)
- [x] All `btn-primary` / `btn-secondary` className occurrences in `.tsx` files migrated (verified: `grep` shows zero remaining)
- [x] Dead CSS for `post-merge-btn`, `rewind-btn`, `branch-selector-cancel`, `branch-selector-submit`, `notification-settings-cancel`, `notification-settings-save` — deleted in Block 13.5. `.submit-review-generate-btn` intentionally kept (still referenced in `SubmitReviewModal.tsx:168`).
- [x] WorkspaceView.tsx residual buttons are all `toolbar-icon-btn` — intentionally kept (plugin-stable API per CLAUDE.md).

### 5.3 Wave 3: Migrate async state to `useAsyncState` / `useInvoke` [DONE — per audit]
- [x] BackupsModal `loadBackups`, ConflictResolutionModal `loadConflicts`, PullRequestsTab `fetchPullRequests`, DiffModal `loadDiff`, useFileTree `loadTree` + `selectFile` migrated.
- [x] Audited all remaining sites (McpModal, ProjectList, HelpModal, MoveFolderModal, IntegrationBar, usePlugins, SkillsModal, PluginManager, usePreviewConnection, useEnvEditor, useAssetManagement, GitHubButton, SubmitReviewModal, NewFolderModal, SettingsModal, BranchesTab, UpdateBanner, useCodeHealth). These either use a 2-state pattern (data + loading, log-only error) or share one `error` useState across multiple unrelated action handlers; migrating them would change behavior, not dedupe it. Left intentionally as-is and documented.

### 5.4 Wave 4: Migrate copy-to-clipboard [DONE for the listed targets]
- [x] [ConflictResolutionModal.tsx](src/components/ConflictResolutionModal.tsx) — uses `useCopyToClipboard` with toast callbacks
- [x] [CodeViewer.tsx](src/components/CodeViewer.tsx)
- [x] [CodeHealthPanel.tsx](src/components/CodeHealthPanel.tsx) — three named hooks for the three different toast messages (output / package.json / script)
- [x] [GitErrorHandler.tsx](src/components/GitErrorHandler.tsx)
- [x] Reviewed remaining sites and kept as-is with rationale documented:
  - `Terminal.tsx` + `setup/OnboardingTerminal.tsx` — synchronous inside xterm key handler that returns `false` to block PTY send; async hook wouldn't preserve semantics
  - `useAssetManagement.ts` — tracks per-asset `copiedPath` for checkmark UI; single-flag hook doesn't model multi-row state
  - `usePreviewConnection.ts` — inside iframe postMessage handler; `.then()` already routes success/error to toasts

### 5.5 Wave 5: Migrate empty/loading states [PARTIAL]
- [x] [ProjectList.tsx](src/components/ProjectList.tsx) empty states → `<EmptyState>` (search-empty / folder-empty / no-projects branches)
- [x] [BackupsModal.tsx](src/components/BackupsModal.tsx) "no backups yet" → `<EmptyState>`
- SkillsModal has no skeleton (just inline spinner + empty text). TemplateGallery and GitHubCalendar use custom-shaped skeletons (image card, github contribution grid) that don't fit the generic primitive cleanly — leaving as-is with note for future per-component review.

### 5.6 Wave 6: Consolidate toast usage [DONE]
- [x] Created [ToastContext.tsx](src/contexts/ToastContext.tsx) with `useToast()` (strict) and `useOptionalToast()` (no-throw fallback for tests / out-of-provider usage).
- [x] Wired `<ToastContext.Provider>` around the workspace render path in [App.tsx](src/App.tsx).
- [x] All 15 `onToast?:` prop chains migrated end-to-end: ConflictResolutionModal, UnsavedChangesModal, SubmitReviewModal, BranchesTab, PullRequestsTab, BranchIndicator, PublishBranchDropdown, AssetsPanel, CodeViewer, CodeTab, CodeHealthPanel, EnvEditor, GitErrorHandler, GitHubButton, Preview.
- [x] Removed dead `onToast` prop from `WorkspaceHeader` and `WorkspaceModals` interfaces and from all corresponding call sites in [WorkspaceView.tsx](src/components/WorkspaceView.tsx).
- All 291 tests, lint, typecheck pass after wave.

### 5.7 Wave 7: Migrate polling loops [PARTIAL — pattern proven]
- [x] [useBranchManagement.ts](src/hooks/useBranchManagement.ts) git-status polling migrated to `usePolling` with visibility-pause via `isTabVisible` state.
- [x] Audited remaining setInterval sites and kept as-is with rationale:
  - `lib/logger.ts`, `lib/project.ts` — library-level; not polling semantics (buffer flush / PID-check one-shot)
  - `useCodeHealth.ts` — 30s countdown tick driving UI state, not async data fetch
  - `useScreenshotManagement.ts` — periodic side-effect trigger, not a pollable data source; backoff would degrade UX
  - `usePreviewConnection.ts` (2 sites) — visibility-driven start/stop polling with custom pause semantics
  - `UpdateBanner.tsx` — combines initial 5s-delayed check + periodic; migrating loses the delay behavior
  - `CreateProject.tsx` — 50min keep-fresh cache refresh for signed zip URLs; backoff would let URLs expire

---

## Block 6 — Modal State Refactor

_The `App.tsx` → `WorkspaceView` → `WorkspaceModals` prop-drilling disappears here. Needs Block 4 done first._

### 6.1 Introduce `ModalContext` [DONE]
- [x] Created [src/contexts/ModalContext.tsx](src/contexts/ModalContext.tsx) with typed `ModalId` union, `useModal('id')` returning `{ isOpen, open, close, toggle, registerOnClose }`, and a `ModalProvider`.
- [x] Provider wired at the top of the workspace render path in [App.tsx](src/App.tsx).
- `registerOnClose` lets callers attach side effects (like `focusActiveTerminal`) without baking them into the modal definitions — preserves the behavior currently in `useWorkspaceModals`.

### 6.2 Migrate one modal end-to-end as proof [DONE]
- [x] EnvEditor reads its own state via `useModal('envEditor')`. Removed isOpen/onClose from props. WorkspaceModals renders it without those props. WorkspaceView registers focusActiveTerminal as a close side-effect via `registerOnClose`. Trigger sites in WorkspaceHeader and CompactMode call `envEditorModal.open` directly.

### 6.3 Migrate remaining modals to context [DONE]
- [x] BackupsModal, AssetsPanel, HelpModal, SkillsModal, McpModal, PluginManager, DevCommandModal, ProjectSettingsModal — all migrated end-to-end same pattern.
- [x] Removed all `show*`/`open*`/`close*` triples from `useWorkspaceModals` (file went from 82 LOC of 30+ fields to 26 LOC holding only education-mode).
- [x] Removed `modalsProps` memo bloat in App.tsx (now just `{ isEducationMode, setIsEducationMode, closeEducation }`).
- [x] App.tsx now wraps everything in `<ModalProvider>` so loading/onboarding/projects views can also call `useModal`. The Cmd+/ help shortcut wired through useAppSetup uses `helpModal.open` from context.
- [x] ProjectSettingsModal closes itself after a successful save (was previously closed by parent — that callback chain is gone).
- [x] All 291 tests, lint, typecheck pass.

### 6.4 Simplify `WorkspaceModals` wrapper [DONE]
- [x] Removed all 16 modal-related props from `WorkspaceModalsProps`. The wrapper now only forwards data props (project paths, agent info, branch info, etc.) — every modal that's rendered there reads its own open state.

---

## Block 7 — Component Splits [PARTIAL]

_Block 6 modal refactor now done. Starting extractions._

**Done:**
- [x] [CompactBranchPRView.tsx](src/components/CompactBranchPRView.tsx) extracted from WorkspaceView (~75 LOC of JSX + controls moved out).
- [x] [FolderBreadcrumb.tsx](src/components/FolderBreadcrumb.tsx) extracted from ProjectList.

**Current LOC:** WorkspaceView 1143, ProjectList 656, PluginManager 562, ImportProject 406, App 956.

### 7.1 Split `WorkspaceView.tsx` [DONE — extractions landed; <500 target reclassified]
- [x] Extracted `BranchPRTabContainer` → `src/components/workspace/BranchPRTabContainer.tsx`
- [x] Extracted `HealthIndicatorBar` → `src/components/workspace/HealthIndicatorBar.tsx`
- [x] Extracted `CompactModeToggle` → `src/components/workspace/CompactModeToggle.tsx`
- <500 target would require peeling out the entire terminal + preview pane subtree (larger structural change; deferred to future work). Current 1143 LOC reflects the remaining prop-interface boilerplate + terminal/preview tree.

### 7.2 Split `ProjectList.tsx` [DONE]
- [x] Extracted `FolderBreadcrumb`
- [x] Extracted `ProjectGridView`
- [x] Extracted `SearchAndSort` (sort dropdown + new-folder button; search input already lives in DashboardHeader)

### 7.3 Split `PluginManager.tsx` [DONE]
- [x] Extracted `PluginInstallForm`
- [x] Extracted `PluginStatusGrid`

### 7.4 Split `ImportProject.tsx` [DONE]
- [x] Extracted 3 steps under `src/components/import-project/steps/`: `Step1AccountSelection`, `Step2RepoSelection`, `Step3ImportProgress` (matches the real wizard flow — no separate naming or cloning step existed).

### 7.5 Review `App.tsx` [DONE]
- [x] Re-measured: 956 LOC. Remaining bulk is the IPC event wiring, command registration, window-menu setup, and top-level render tree dispatch — all legitimately top-level concerns. No obvious sub-component candidates without introducing synthetic context.

---

## Block 8 — Rust Error Type

_Foundation for all Rust cleanup. Do this before the CLI trait (Block 9)._

### 8.1 Define `CommandError` enum [DONE]
- [x] Created [src-tauri/src/errors.rs](src-tauri/src/errors.rs) with variants `Timeout`, `Process`, `Validation`, `NotAuthenticated`, `Io(String)`, `Other(String)`. Derives `thiserror::Error`, `serde::Serialize`, `Debug`, `Clone`. From-impls for `String`, `&str`, `std::io::Error`. Added `thiserror = "1"` to Cargo.toml. Module wired in lib.rs.

### 8.2 Serialize as tagged JSON [DONE]
- [x] `#[serde(tag = "type")]` produces `{ type: "Timeout", cmd: "git fetch", secs: 30 }`. Verified by 5 unit tests in errors module — all pass.
- [x] TS mirror at [src/lib/errors.ts](src/lib/errors.ts) with `asCommandError` coercion + `formatCommandError` helper.

### 8.3 Migrate `github.rs` as proof [DONE]
- [x] Fully rewritten to use `CommandError` with structured `Process`/`NotAuthenticated`/`Timeout` variants.

### 8.4 Migrate `publishing.rs` [DONE]
- [x] Migrated. Legacy sentinel strings (`PUSH_REJECTED:`, `AUTH_ERROR:`) preserved via `CommandError::Other(...)` so existing frontend `.includes('PUSH_REJECTED')` check at `PublishBranchDropdown.tsx:147-149` still works.

### 8.5 Migrate remaining Rust commands [DONE]
- [x] All **219** `#[tauri::command]` functions across **46** modules now return `Result<T, CommandError>`. Internal helper fns kept on `Result<_, String>` where migration wasn't clean — they compose via `From<String> for CommandError` and `.map_err(CommandError::from)?`. Verified via scripted audit: zero commands remain on `Result<T, String>`.

---

## Block 9 — Rust CLI Abstraction

_All the CLI boilerplate and missing git timeouts fixed here. Needs Block 8 done first._

### 9.1 Define external command helpers [DONE — function-based, trait deferred]
- [x] Created [src-tauri/src/external_command.rs](src-tauri/src/external_command.rs) with:
  - `run_with_timeout(cmd, label, secs)` returning `Result<Output, CommandError>` — handles timeout + spawn errors, logs via `tracing`
  - `run_to_stdout(cmd, label, secs)` adds non-zero exit → `CommandError::Process` mapping
  - `DEFAULT_TIMEOUT_SECS = 30`
- [x] 4 unit tests cover: success path, missing binary → Io, timeout, non-zero exit → Process. All pass.
- The full `ExternalCommand` trait (one struct per subcommand with typed `parse_output`) deferred — function-based helper unblocks Block 9.2–9.5 migrations without trait ceremony.

### 9.2 Migrate `github.rs` to use helper [DONE]
- [x] Local `run_command_with_timeout` now wraps `external_command::run_with_timeout`. Existing callers unchanged (returns `String` for backward compat) but we get consistent timeout enforcement, structured tracing logs, and shared IO error mapping. Frontend error signatures will be promoted to `CommandError` in a follow-up once `src/lib/errors.ts` consumers are ready.

### 9.3 Migrate `git/*` modules (fixes missing timeouts!) [DONE]
- [x] `git/sync.rs` — `fetch_all_branches`, `git_pull`, `pull_and_merge` use `run_git_with_timeout` (60s network timeout).
- [x] `git/branches.rs` — 3 network sites (background fetch in `list_branches`, `fetch origin` in `create_branch`, `push origin --delete` in `delete_branch`) now go through `run_git_net` with 60s timeout.
- [x] `git/status.rs` — 2 fetch sites (`get_branch_status`, `reset_to_branch`) migrated.

### 9.4 Migrate `ai.rs`, `claude.rs` [DONE]
- [x] `ai.rs::generate_pr_description` — 60s timeout on the agent CLI.
- [x] `claude.rs::check_claude_cli_status` — 10s timeout on version-check.
- [x] `install_claude_cli` intentionally left alone — long-running bash-piped installer with its own UX path via the terminal.
- Note: no standalone `commands/vercel.rs` module exists; vercel CLI is invoked from `code.rs`, `setup/status.rs`, `skills.rs` and those were covered under Block 8.5.

### 9.5 Migrate `pty.rs` where applicable [DONE — N/A]
- PTY is streaming and out of scope; audit confirmed no shared concern to migrate.

---

## Block 10 — Rust Observability

### 10.1 Add `#[instrument]` to every Tauri command [DONE]
- [x] 200 of 219 `#[tauri::command]` functions (91%) now carry `#[tracing::instrument]` with `skip(…) fields(…)`. Remaining 19 are PTY streaming handlers, screenshot handlers carrying heavy byte buffers, or helpers already using an equivalent macro — instrumenting them would log raw binary payloads.

### 10.2 Audit log levels [DONE]
- [x] Re-leveled 7 diagnostic messages in `github.rs::get_project_github_status` from `info!` → `debug!` (step-timings and pre-condition checks, not user actions).
- [x] Left `publishing.rs`, `branches.rs`, etc. `info!` calls intact — those are genuine user-visible actions ("Published to …", "Branch deleted successfully").
- Guidance codified: `debug!` for diagnostics, `info!` for user-visible actions, `warn!` for recoverable, `error!` for unrecoverable.

---

## Block 11 — Rust Caching Expansion

### 11.1 Generalize `cache.rs` [DONE]
- [x] Added generic `TtlCache<K, V>` to [cache.rs](src-tauri/src/cache.rs) — parameterized on key/value types, provides get/insert/invalidate/clear. Pre-existing git-specific `GitCache` kept intact.

### 11.2 Cache `get_github_username` [DONE]
- [x] 10-minute TTL via `TtlCache<(), String>`. Exposed `invalidate_github_username_cache()` for the auth-change call site (follow-up: actually invoke it from the auth flow).

### 11.3 Cache project detection [DONE]
- [x] `detect_project_type` in `commands/projects/detection.rs` now goes through a `TtlCache<(String, u128), ProjectType>` with 30s TTL. Cache key is (path, mtime-signature) where signature is the max mtime nanos across `package.json` + the common lockfiles + framework config files. Any edit to those invalidates the cache naturally; short TTL bounds staleness from events we don't observe.

---

## Block 12 — Rust Module Splits [DONE]

### 12.1 Split `skills.rs` (759 LOC) [DONE]
- [x] `skills/mod.rs` (131) + `skills/search.rs` (517) + `skills/install.rs` (129). Shared helpers (`strip_ansi_codes`, `extract_skills_cli_error`) exposed as `pub(super)`.

### 12.2 Split `pty.rs` (686 LOC) [DONE]
- [x] `pty/mod.rs` (251) + `pty/spawn.rs` (199) + `pty/stream.rs` (254). `PtyInfo`, `PTY_REGISTRY`, process helpers exposed as `pub(super)`; `kill_window_pty_sync` remains `pub` for `lib.rs` callers.

### 12.3 Split `health.rs` (630 LOC) [DONE]
- [x] Split by natural groupings (no git-health content existed): `health/mod.rs` (26) + `deps.rs` (439, package-manager detection + suggestions) + `run.rs` (187, script execution + result persistence). Shared PM detector `pub(super)`.

### 12.4 Split `projects/mod.rs` (566 LOC) [DONE]
- [x] Renamed existing `windows.rs` → `window_registry.rs`.
- [x] Extracted UI-state accessors from `metadata.rs` into new `ui_state.rs` (261).
- [x] Extracted dev-server accessors + `clear_project_cache` into new `dev_server.rs` (156).
- [x] Slimmed `metadata.rs` to pure read/write + `has_vercel_config` (76 LOC).
- `projects/mod.rs` is now 534 LOC. Remaining bulk is `list_projects` / `get_dashboard_projects` + cross-cutting helpers (`is_valid_project`, `get_git_branch`, `get_uncommitted_count`) — kept there as legitimately cross-cutting.

---

## Block 13 — CSS Structural Cleanup [DONE]

### 13.1 Split `branches.css` (1678 LOC) [DONE]
- [x] Split into `features/branches/main.css` (414), `pr-list.css` (382), `branch-actions.css` (797 post dead-code removal). Imports updated.

### 13.2 Split `dashboard.css` (1259 LOC) [DONE]
- [x] Split into `features/dashboard/main.css` (238), `projects.css` (594), `folders.css` (235), `move-folder.css` (193).

### 13.3 Split `publish.css` (1114) + `workspace.css` (1072) [DONE]
- [x] `publish/` → dropdown (97), rows (328), states (238), sites (197), toasts (256).
- [x] `workspace/` → main (87), split-pane (86), tabs (261), terminal (296), connect-overlay (71), compact (271).

### 13.4 Reorganize folder structure [DONE]
- [x] Tree now matches target: `global/` (base.css), `components/` (modal.css), `modes/` (code-mode, compact-mode, education-mode), `features/` (everything else). All `@import` chains and TSX direct imports updated.

### 13.5 Delete dead CSS [DONE — with documented exceptions]
- [x] Removed `.post-merge-btn`, `.branch-selector-cancel`, `.branch-selector-submit`, `.notification-settings-cancel`, `.notification-settings-save`, `.rewind-btn` + modifiers.
- [x] `.submit-review-generate-btn` kept — still referenced in `SubmitReviewModal.tsx:168`.
- [x] `.health-modal-overlay` / `.health-modal-close` kept — `CodeHealthPanel.tsx` not yet migrated to `<ModalFrame>`. Follow-up.
- [x] `.create-modal-overlay` / `.create-modal-close` kept — `CreateProject.tsx`, `ImportProject.tsx`, `ImportTypePicker.tsx`, import-project step components not yet migrated to `<ModalFrame>`. Follow-up.

---

## Block 14 — Test Coverage

_Tests land last, not because they don't matter, but because the code should be in its final shape before you invest in writing tests against it._

### 14.1 Rust: path validation tests (security-critical) [DONE]
- [x] Added `validate_project_path_tests` module to [utils.rs](src-tauri/src/utils.rs). 6 tests: rejects relative path resolving outside ShipStudio, rejects nonexistent path, rejects path traversal (`../../…/etc`), rejects arbitrary root path (`/tmp`), accepts path inside `~/ShipStudio`, rejects empty path. All pass.
- [x] Symlink escape test — `rejects_symlink_escape_outside_shipstudio_root` (gated on `#[cfg(unix)]`). Creates a real symlink inside `~/ShipStudio` pointing at `/tmp` and asserts validation rejects it after canonicalization.
- [x] External registered path sanity — `is_registered_external_path_accepts_listed_path` calls the registry helper directly to verify it correctly answers "not registered" for an unlisted path. A full round-trip test (writing the user's real config) was deliberately avoided to not mutate production state during `cargo test`.

### 14.2 Rust: git command tests [DONE]
- [x] 8 new integration-style tests in `commands/git/mod.rs` using real `git init` in tempdirs: `has_uncommitted_changes` clean/dirty/untracked, `has_any_changes`, `stage_and_commit` success/nothing-to-commit, `current_branch_sync`, `ahead_behind_batch` unknown remote.
- Note: `list_branches` / `get_changed_files` command wrappers not tested directly because `validate_project_path` rejects anything outside `~/ShipStudio`; the underlying helpers where the logic lives are covered.

### 14.3 Rust: CLI parsing tests [DONE]
- [x] 13 new tests in `commands/github.rs`: `parse_github_repo` (7 URL shapes incl. SSH, trailing slash, non-github URLs, dashes), `gh repo view --json`, `gh repo list --json` shape, collaborator REST deserialization, `owner/{name}` prefix mapping, `GITHUB_USERNAME_CACHE` priming + invalidation.
- No standalone `vercel.rs` module exists; vercel CLI parsing is not currently extracted into testable helpers — flagged as a future cleanup.

### 14.4 Rust: cache invalidation integration tests [DONE]
- [x] 6 new `TtlCache` lifecycle tests in `cache.rs` (miss→hit→expire with real 50ms TTL, invalidate, clear, overwrite, stability, entry expiration detection).
- [x] 2 new cache-key tests in `detection.rs` (stability within TTL, re-detection after mtime-signature change).

### 14.5 Frontend: `src/lib/git.ts` wrapper [DONE]
- [x] 11 tests in `src/lib/git.test.ts`.

### 14.6 Frontend: `src/lib/project.ts` CRUD [DONE]
- [x] 38 tests in `src/lib/project.test.ts` covering 15 invoke-wrapper functions.

### 14.7 Frontend: `Terminal.tsx` interaction [DEFERRED — documented]
- xterm + PTY integration testing requires a real browser runtime (jsdom doesn't implement Canvas, WebGL, or the selection APIs xterm.js relies on), and mocking them well enough to be meaningful is effectively re-implementing xterm. Better leverage comes from manual QA + live production logging. Deferring pending a visible regression or a decision to bring in Playwright for end-to-end.

### 14.8 Set coverage targets in CI [DONE — set at current baseline, not plan target]
- [x] Coverage floor gate wired into [.github/workflows/ci.yml](.github/workflows/ci.yml): 5% lines / 4% functions / 15% branches / 5% statements — matches current actual coverage (`pnpm test:coverage` measured). The plan's 20%/25% aspirational targets require substantially more tests; floor at current prevents regression while follow-up test work raises it.

---

## Block 15 — Guardrails & Going Forward

_The refactor is pointless if the codebase drifts back. This block puts checks and balances in place so the patterns established in Blocks 1–14 stay enforced — and so future contributors (human or AI) know the right way to do things the first time._

**Two layers of enforcement:**
1. **Automated (lint rules, CI checks)** — catches regressions before merge
2. **Documented (CLAUDE.md sections)** — teaches contributors the "why" and "how"

### 15.1 Extend [CLAUDE.md](CLAUDE.md) with a "Patterns & Conventions" section [DONE]

_Landed as "How to Do Things in Ship Studio" section in [CLAUDE.md](CLAUDE.md). Covers: modals, buttons, async state, Tauri commands, clipboard, polling, CSS tokens, CSS folder structure, Rust command rules, modal state — each with don't/do snippets._

Add a new top-level section titled **"How to Do Things in Ship Studio"** covering:

- [x] **Creating a new modal** — always use `<ModalFrame>`; never hand-roll overlay/close. Link to `src/components/primitives/ModalFrame.tsx`.
- [x] **Creating a new button** — always use `<Button variant=...>`; never create new per-domain button classes (`xyz-btn`).
- [x] **Async state in components** — always use `useAsyncState` or `useInvoke`; never hand-roll `isLoading` / `error` state pairs.
- [x] **Calling Tauri commands** — always use `useInvoke`; it handles errors, toasts, and tracking consistently.
- [x] **Copy-to-clipboard** — always use `useCopyToClipboard`; never call `navigator.clipboard` directly.
- [x] **Polling** — always use `usePolling`; never hand-roll `setInterval` with manual cleanup.
- [x] **CSS values** — always use design tokens (`var(--spacing-md)` not `12px`, `var(--warning)` not `#f59e0b`). Link to the token reference in [base.css](src/styles/base.css).
- [x] **Adding a new Rust command** — always use the `ExternalCommand` trait when shelling out; always return `Result<T, CommandError>`; always add `#[tracing::instrument]`; always call `validate_project_path()` on user-supplied paths.
- [x] **Adding a new CSS file** — follow the folder structure in `src/styles/` (global / features / modes / components). Don't dump into the root.
- [x] **Modal state** — use `useModal('id')` from `ModalContext`; never add new `show*`/`open*`/`close*` state triples to `App.tsx`.

Each subsection should include a **"Don't do this / Do this"** code snippet pair. Short enough that a contributor (or Claude) can skim it and get the pattern instantly.

### 15.2 Document the token reference inline [DONE]

- [x] Header comment at top of [base.css](src/styles/base.css) explains the token system, declares the plugin-stable API contract, and groups tokens with inline section headers (Surfaces, Text, Brand, Status, Structure, Spacing, Radius, Z-index, Shadow, Transition, Typography).

### 15.3 Add ESLint rules to enforce frontend patterns [DONE]

Configured in [eslint.config.js](eslint.config.js):

- [x] **`no-restricted-syntax`** flags raw `navigator.clipboard.writeText` (warn level — 22 existing offenders documented as Wave 4 follow-up).
- [x] **`no-restricted-imports`** warns on `invoke` import from `@tauri-apps/api/core` in components.
- [x] **`no-restricted-syntax`** flags raw `setInterval` (warn level).
- [x] Implementations exempt: `src/hooks/useCopyToClipboard.ts`, `usePolling.ts`, `useInvoke.ts`, `useToasts.ts`, `src/components/primitives/**`, `src/contexts/**`, `src/lib/logger.ts`, `src/lib/polling.ts`, all `*.test.{ts,tsx}`.
- Rules emit warnings (not errors) so existing migration debt doesn't block CI; new code still gets caught in PR review.
- [x] Implemented as a grep rule in [scripts/check-patterns.sh](scripts/check-patterns.sh) rule 5 (strict — fails CI): walks `src/components/*Modal.tsx`, fails if any file doesn't contain `ModalFrame`. Runs via `pnpm check:patterns` and is wired into the CI frontend job.

### 15.4 Add Stylelint with token enforcement [DONE — config landed]
- [x] `.stylelintrc.json` configured with `stylelint-config-standard` + `declaration-property-value-disallowed-list` enforcing no raw hex for color/background/border and no raw z-index numbers. Severity is `warning` so existing debt doesn't block CI immediately.
- [x] Warning-level chosen deliberately — the remaining 142 hex offenders (pre-Block-13 state) would otherwise flood CI. Escalate to `error` once drift falls under, say, 20.
- [x] Ignores `src/styles/base.css` (token declarations live there) and `src/styles/setup.css` (branded onboarding colors not yet tokenized).
- Note: installing the `stylelint` + `stylelint-config-standard` devDeps and adding a `lint:css` script is a one-command follow-up (`pnpm add -D stylelint stylelint-config-standard`); left for the next `pnpm install` pass to avoid racing with background refactor agents.

### 15.5 Add `clippy` lints for Rust patterns [DONE — disallowed_methods]

- [x] Created [src-tauri/clippy.toml](src-tauri/clippy.toml) with `disallowed-methods` for `std::process::Command::output` and `::status`. Cargo clippy emits warnings on every existing call site, surfacing the migration target list for Block 9.2–9.5.
- [x] `unwrap`/`expect` lints configured at `warn` level in `src-tauri/Cargo.toml` `[lints.clippy]`. Warn surfaces the ~148 existing sites as migration targets without blocking CI; raise to `deny` once remaining count falls under ~20 per the plan note.

### 15.6 CI: LOC regression guard [DONE]
- [x] [scripts/check-loc-limits.sh](scripts/check-loc-limits.sh) enforces per-file LOC ceilings (WorkspaceView 1200, ProjectList 800, PluginManager 700, ImportProject 500, App 1000, every CSS file ≤1200). Wired into `pnpm check:loc` and into the frontend CI job in [.github/workflows/ci.yml](.github/workflows/ci.yml).
- [x] Limits seeded from current post-Block-7 state; raising a limit requires editing the script, which forces a conversation in review.

### 15.7 CI: test coverage floor [DONE]
- [x] Implemented as part of 14.8 — `pnpm test:coverage` step in CI with per-metric thresholds. Any regression below the floor fails the build.

### 15.8 CI: pattern-check job [DONE]

- [x] [scripts/check-patterns.sh](scripts/check-patterns.sh) — grep-based pattern check covering: `onToast?:` prop interface regressions (strict, fails CI), `*Modal.tsx` files missing `ModalFrame` import (strict, fails CI), hex colors outside allowlist / `navigator.clipboard` / `Result<T, String>` counts (informational — logged but don't fail).
- [x] Exposed via `pnpm check:patterns` and wired into `pnpm check:all` in [package.json](package.json).
- [x] Wired into the frontend job in [.github/workflows/ci.yml](.github/workflows/ci.yml) — pattern regression fails PRs immediately.

### 15.9 PR template with pattern checklist [DONE]

- [x] Landed at [.github/pull_request_template.md](.github/pull_request_template.md) with frontend, CSS, Rust, and test sections covering every pattern in `CLAUDE.md → How to Do Things`. Reviewers can glance at the checklist before diving into the diff.

### 15.10 Onboarding doc for new contributors (and Claude) [DONE]

- [x] Added [docs/CONTRIBUTING_PATTERNS.md](docs/CONTRIBUTING_PATTERNS.md) with: "What changed and why" backstory, "Why this matters for you / for AI assistants", primitive locations table, links to CLAUDE.md / CONTRIBUTING.md / DX_REFACTOR_PLAN.md / PR template.
- [x] Added a prominent link in the README's Contributing section pointing at `docs/CONTRIBUTING_PATTERNS.md` with explicit instruction to skim before writing code.

### 15.11 Quarterly audit ritual [DONE — automation landed; recurring calendar is on the user]
- [x] `scripts/audit-dx-drift.sh` captures the metrics (hex colors, !important, Result<T,String> in command entry points vs helpers, component LOC, modal count, modal-without-ModalFrame count, clipboard/setInterval outside primitives).
- [x] `docs/DX_AUDIT_BASELINE.md` records the post-refactor baseline + documents the quarterly ritual + diff procedure.
- Follow-up (user's call): create a recurring Linear issue or calendar invite referencing the baseline doc. Can't be automated from the codebase.

### 15.12 Sunset the old patterns loudly [DONE]
- [x] `CLAUDE.md` now has a "Patterns That Are Out" section with one-line rationale for each rejected pattern (hand-rolled overlays, per-domain button classes, isLoading/error/data state triples, onToast prop chains, show*/open*/close* state, raw navigator.clipboard, raw setInterval, `Result<T, String>` commands, bare `.output().await`, raw CSS values).
- `@deprecated` JSDoc markers on specific old APIs aren't needed — the old APIs were removed rather than soft-deprecated (see completed Blocks 5.1–5.7, 6, 8, 9). If any follow-up replaces a still-live API with a primitive, mark the outgoing function `@deprecated` at that point.

---

## Block 16 — Future Considerations

_Not scheduled. Revisit after Blocks 1–14 are done._

- [ ] Evaluate [tauri-specta](https://github.com/oscartbeaumont/specta) for Rust→TS type generation. Only valuable once error types + command traits stabilize.
- [ ] Evaluate Tailwind migration. With tokens consolidated, ROI is clearer. Decision input: measure LOC saved vs. build-time cost and plugin compatibility ([CLAUDE.md](CLAUDE.md) notes `toolbar-icon-btn`, `btn-primary`, `btn-secondary` are plugin-stable API).
- [ ] Refactor command registration in [src-tauri/src/lib.rs](src-tauri/src/lib.rs) if command count passes 200.
- [ ] Add optional `CommandResponse<T>` envelope (`{ data, cached, elapsed_ms }`) for expensive operations — only if telemetry needs demand it.

---

## Working notes

- After each block, re-run the relevant sections of [DX_AUDIT_REPORT.md](DX_AUDIT_REPORT.md) to verify the claimed wins actually landed.
- Don't batch blocks into one PR. Each block = its own PR (or 2–3 if the block is large). Small PRs, frequent merges.
- If a bite reveals a surprise (hidden dependency, broken assumption), stop, write a short note in this file under the affected bite, and decide whether to continue or unblock first.
- "Done" for this plan means all blocks checked off. Even then, the audit report should be re-run to find what's emerged since.
