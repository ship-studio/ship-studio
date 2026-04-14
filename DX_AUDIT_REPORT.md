# Ship Studio — Developer Experience & Refactoring Audit

_Generated 2026-04-14_

This report audits the Ship Studio codebase across four dimensions: **React/TypeScript frontend**, **CSS architecture**, **Rust/Tauri backend**, and **developer workflow tooling**. Findings are prioritized by impact and include concrete file references and refactor suggestions.

Nothing here is "done" — this is a punch list for incremental improvement. Tackle high-impact items first, but most low-effort wins (scripts, hooks, small utilities) can land this week.

---

## Table of Contents
1. [Headline Findings](#headline-findings)
2. [Frontend — Component Reuse & Refactoring](#1-frontend--component-reuse--refactoring)
3. [CSS — Efficiency & Organization](#2-css--efficiency--organization)
4. [Rust Backend — Consistency & Abstractions](#3-rust-backend--consistency--abstractions)
5. [Developer Workflow & Tooling](#4-developer-workflow--tooling)
6. [Recommended Roadmap](#recommended-roadmap)

---

## Headline Findings

| Area | Top Issue | Impact |
|------|-----------|--------|
| Frontend | 15 modal components each reimplement overlay/close logic | HIGH |
| Frontend | `App.tsx` (1019 LOC) + `WorkspaceView.tsx` (1366 LOC) prop-drill 30+ modal boolean/setter pairs | HIGH |
| Frontend | 111 instances of manual `isLoading`/`error` state — no `useAsyncState` hook | HIGH |
| CSS | 52+ hardcoded color values despite CSS variables existing | HIGH |
| CSS | 37 unique padding values, 10 border-radius values, 15 z-index values — no token system | MEDIUM |
| CSS | 5 files over 1,000 LOC; `branches.css` at 1,777 LOC | MEDIUM |
| Rust | 10+ command modules duplicate CLI spawn + timeout + error-mapping boilerplate | HIGH |
| Rust | All commands return `Result<T, String>` — no typed error enum | HIGH |
| Rust | ~1.4% test coverage; no tests for path validation (security-critical) | HIGH |
| DX | Pre-commit hook only lints — no typecheck or test run | HIGH |
| DX | No `test:watch` script; TDD workflow requires manual re-runs | HIGH |

---

## 1. Frontend — Component Reuse & Refactoring

### 1.1 Modal overlay duplication (HIGH)

**Problem:** 15 modal components each reimplement `isOpen` state, overlay click-to-close, stopPropagation, and close-button SVG.

Files: `BackupsModal`, `BranchSelectorModal`, `ConflictResolutionModal`, `DevCommandModal`, `DiffModal`, `HelpModal`, `McpModal`, `MoveFolderModal`, `NewFolderModal`, `NotificationSettingsModal`, `ProjectSettingsModal`, `SettingsModal`, `SkillsModal`, `SubmitReviewModal`, `UnsavedChangesModal`.

Reference: [UnsavedChangesModal.tsx:88](src/components/UnsavedChangesModal.tsx#L88)

**Fix:** Extract `<ModalFrame isOpen onClose title>{children}</ModalFrame>` + `useModalState()` hook. Eliminates ~30 LOC per modal (~450 LOC total).

---

### 1.2 Oversized components (HIGH)

| File | LOC | Recommended Split |
|------|-----|-------------------|
| [WorkspaceView.tsx](src/components/WorkspaceView.tsx) | 1366 | `BranchPRTabContainer`, `HealthIndicatorBar`, `CompactModeToggle` |
| [App.tsx](src/App.tsx) | 1019 | Move modal state into `ModalContext`; move 30+ props from `modalsProps` memo |
| [ProjectList.tsx](src/components/ProjectList.tsx) | 749 | `FolderBreadcrumb`, `ProjectGridView`, `SearchAndSort` |
| [PluginManager.tsx](src/components/PluginManager.tsx) | 687 | `PluginInstallForm`, `PluginStatusGrid` |
| [ImportProject.tsx](src/components/ImportProject.tsx) | 635 | One file per wizard step |

---

### 1.3 Modal state prop drilling (HIGH)

`useWorkspaceModals` ([App.tsx:38](src/App.tsx#L38)) returns 30+ `show*`/`open*`/`close*` triples that thread through `WorkspaceView` → `WorkspaceModals`. See the `modalsProps` memo at [App.tsx:654](src/App.tsx#L654).

**Fix:** Replace with a `ModalContext` (or Zustand store). Each modal becomes `const { isOpen, close } = useModal('envEditor')`. Deletes ~80 props from intermediate component interfaces.

---

### 1.4 Async state duplication (HIGH)

**111 instances** of manual `useState(false)` for `isLoading` + `useState<string | null>(null)` for `error`.

Examples: [EnvEditor.tsx:104](src/components/EnvEditor.tsx#L104), [BranchesTab.tsx:69](src/components/BranchesTab.tsx#L69), [SubmitReviewModal.tsx:45](src/components/SubmitReviewModal.tsx#L45), [ConflictResolutionModal.tsx:37](src/components/ConflictResolutionModal.tsx#L37).

**Fix:** Create `useAsyncState<T>()` returning `{ data, isLoading, error, execute }`. Combine with `useInvoke<T>(cmd)` wrapper for Tauri (76 invoke sites, see §1.6).

---

### 1.5 Button styling inconsistency (MEDIUM)

**167 button instances** across 53 files with inconsistent class patterns:
- `unsaved-changes-btn primary`, `rewind-btn primary`, `post-merge-btn danger`, `btn-primary`, `health-suggestions-btn`, etc.

**Fix:** Single `<Button variant="primary|secondary|danger|ghost" />` component backed by `.button` CSS with variant modifiers. Ties in with CSS audit §2.

---

### 1.6 Tauri invoke error-handling duplication (MEDIUM)

76 `invoke()` sites repeat:
```ts
setIsLoading(true); setError(null);
try { await invoke(...); }
catch (e) { trackError(...); setError(...); onToast?.(...); }
finally { setIsLoading(false); }
```

**Fix:** `useInvoke<T>(cmd)` hook with built-in error tracking + toast. ~150 LOC reduction.

---

### 1.7 Other reusable abstractions (MEDIUM)

- **`useCopyToClipboard`** — 6 components reimplement ([Terminal.tsx](src/components/Terminal.tsx), [ConflictResolutionModal.tsx](src/components/ConflictResolutionModal.tsx), [CodeViewer.tsx](src/components/CodeViewer.tsx), [CodeHealthPanel.tsx](src/components/CodeHealthPanel.tsx), [GitErrorHandler.tsx](src/components/GitErrorHandler.tsx))
- **`<Skeleton>` / `<EmptyState>`** — 20+ custom implementations across `ProjectList`, `SkillsModal`, `TemplateGallery`, `GitHubCalendar`
- **`useToast`** — already exists in `useToasts.ts` but `onToast?` is still threaded as a prop through 15+ modals; modals should call the hook directly
- **`usePolling`** — 39 scattered polling loops, inconsistent cleanup (memory leak risk)

---

## 2. CSS — Efficiency & Organization

**Scope:** 37 CSS files, ~17,125 LOC, centralized in `src/styles/`. Uses CSS custom properties but inconsistently.

### 2.1 Hardcoded colors despite variables (HIGH)

**52+ hardcoded color instances** for values that should be variables:
- `#f59e0b` / `#fbbf24` (warning) — [branches.css:40](src/styles/branches.css#L40), [project-grid.css:213](src/styles/project-grid.css#L213)
- `#10b981` (success) — [plugins.css:340](src/styles/plugins.css#L340)
- `#f44747` (error) — [compact-mode.css:321](src/styles/compact-mode.css#L321)

**Fix:** Define `--warning`, `--warning-light`, `--success`, `--success-light`, `--error`, `--error-light` in `base.css`. Replace all hardcoded instances.

---

### 2.2 Missing design token scales (HIGH)

| Token Type | Unique Values Found | Recommended Scale |
|------------|---------------------|-------------------|
| Padding | 37 | 6 tokens: `--spacing-xs/sm/md/lg/xl/2xl` |
| Border-radius | 10 | 5 tokens: `--radius-sm/md/lg/full` |
| Z-index | 15 (0 → 100000) | 5 tokens: `--z-dropdown/modal-overlay/modal/tooltip/notification` |
| Box-shadow | 14 | 4 tokens: `--shadow-sm/md/lg` |
| Transitions | 6 durations | 3 tokens: `--transition-fast/default/slow` |

Top shadow offender: `0 8px 24px rgba(0,0,0,0.4)` appears **11 times**.

**Fix:** Add all scales to `base.css`. Replacement across existing files can be incremental (script-assisted find/replace).

---

### 2.3 Repeated layout pattern (MEDIUM)

`display: flex; align-items: center; justify-content: center;` appears **131+ times**.

**Fix:** Add `.flex-center` utility class to `base.css`. Saves ~200 LOC.

---

### 2.4 Monolithic files (MEDIUM)

Files over 1,000 LOC:
- [branches.css](src/styles/branches.css) — 1,777 LOC, 239 selectors
- [dashboard.css](src/styles/dashboard.css) — 1,259 LOC
- [publish.css](src/styles/publish.css) — 1,125 LOC
- [workspace.css](src/styles/workspace.css) — 1,072 LOC

**Fix:** Split by sub-feature (e.g., `branches/main.css`, `branches/pr-list.css`).

---

### 2.5 Variable naming inconsistency (MEDIUM)

- `var(--accent-color)` vs `var(--accent)` — duplicate definitions
- `var(--warning-color, #f59e0b)` — fallback syntax suggests incomplete migration
- `var(--font-mono)` defined but never used; `font-family: monospace` hardcoded instead

**Fix:** Standardize to single names, remove fallbacks, use defined `--font-mono` everywhere.

---

### 2.6 `!important` usage (MEDIUM)

46 instances indicate specificity wars. Examples: [project-grid.css:266](src/styles/project-grid.css#L266), [compact-mode.css:351](src/styles/compact-mode.css#L351).

**Fix:** Audit specificity; lower base selector weight; eliminate where possible.

---

### 2.7 Proposed folder structure (MEDIUM)

```
src/styles/
├── global/     (base.css, typography, utilities)
├── features/   (branches/, plugins/, dashboard/, publish/)
├── modes/      (compact-mode.css, education-mode.css)
└── components/ (shared: modal, tooltip, button)
```

**Note on Tailwind:** With 17k LOC of custom CSS and consistent CSS-variable-driven theming, a full Tailwind migration has moderate ROI. Keep custom CSS but adopt a token-first discipline. Revisit once design tokens are consolidated.

---

## 3. Rust Backend — Consistency & Abstractions

### 3.1 What's already good ✓

- **Path validation is centralized** in [utils.rs:345](src-tauri/src/utils.rs#L345) — `validate_project_path()` is the single source of truth across 32 command modules
- **Git cache** (`cache.rs`) is well-designed and used in `git/branches.rs`, `git/status.rs`, `git/sync.rs`, `git/stash.rs`
- **Command registration** in `lib.rs` (~170 commands) is organized with section comments

### 3.2 Error handling (HIGH)

All commands return `Result<T, String>` — the frontend can't distinguish a timeout from an auth failure without string-sniffing.

Example: [github.rs:22](src-tauri/src/commands/github.rs#L22), [ai.rs:88](src-tauri/src/commands/ai.rs#L88), [publishing.rs](src-tauri/src/commands/publishing.rs).

**Fix:**
```rust
pub enum CommandError {
    Timeout { secs: u64, cmd: String },
    Process { exit_code: i32, stderr: String },
    Validation { field: String, reason: String },
    NotAuthenticated { service: String },
}
```
Derive `serde::Serialize`; frontend can switch on error variants for targeted UX.

---

### 3.3 CLI invocation boilerplate (HIGH)

Every command shelling out to `git`, `gh`, `vercel`, `npm`, `claude` repeats:
```rust
let mut cmd = create_command("git");
cmd.env("PATH", get_extended_path());
cmd.args([...]);
let out = cmd.output().map_err(|e| e.to_string())?;
if !out.status.success() { return Err(stderr); }
```

Files: [github.rs:18](src-tauri/src/commands/github.rs#L18), [pty.rs:70](src-tauri/src/commands/pty.rs#L70), [publishing.rs](src-tauri/src/commands/publishing.rs), [git/mod.rs](src-tauri/src/commands/git/mod.rs), [ai.rs](src-tauri/src/commands/ai.rs).

**Critical gap:** `github.rs` has `run_command_with_timeout` but git commands have **no timeouts** — they can hang indefinitely on network issues.

**Fix:** Trait-based abstraction:
```rust
pub trait ExternalCommand {
    type Output: serde::Serialize;
    fn binary(&self) -> &str;
    fn args(&self) -> Vec<&str>;
    fn timeout_secs(&self) -> u64 { 30 }
    fn parse_output(&self, stdout: String, stderr: String) -> Result<Self::Output, CommandError>;
}
pub async fn run_external<T: ExternalCommand>(cmd: T) -> Result<T::Output, CommandError>;
```

Unified timeout, retry, logging, error mapping.

---

### 3.4 Test coverage (HIGH)

Only 5 of 24 top-level modules have tests: `ai`, `code`, `health`, `mcp`, `skills`. **~200 test LOC against ~14,000 source LOC (~1.4%)**.

**Priority test targets:**
1. `utils.rs::validate_project_path()` — security-critical, zero tests
2. `git/mod.rs::git_stage_and_commit()` — complex, untested
3. `github.rs` — CLI output parsing, error branches
4. `cache.rs` invalidation integration points

---

### 3.5 Caching underutilization (MEDIUM)

- [github.rs:104](src-tauri/src/commands/github.rs#L104) — `get_github_username()` shells out on every call (should cache 10+ min)
- [projects/detection.rs](src-tauri/src/commands/projects/detection.rs) — project-type detection scans FS every call

**Fix:** Extend `cache.rs` with a generic `cache_with_ttl<K, V>`.

---

### 3.6 Logging sparsity (MEDIUM)

- **Zero `#[instrument]` macros anywhere** → no automatic span context
- Modules with no tracing logs: `conflicts.rs`, `env.rs`, `folders.rs`, `mcp.rs`, `pull_requests.rs`, `git/sync.rs`

**Fix:** Add `#[tracing::instrument(skip(path), fields(project = ?path))]` to all 50+ Tauri commands. Frees observability for production debugging.

---

### 3.7 Large modules to split (MEDIUM)

| File | LOC | Split Suggestion |
|------|-----|------------------|
| [skills.rs](src-tauri/src/commands/skills.rs) | 751 | `skills/{search,install,mod}.rs` |
| [pty.rs](src-tauri/src/commands/pty.rs) | 680 | `pty/{spawn,stream,mod}.rs` |
| [health.rs](src-tauri/src/commands/health.rs) | 622 | split by check type |
| [projects/mod.rs](src-tauri/src/commands/projects/mod.rs) | 554 | `projects/{ui_state,dev_server,window_registry}.rs` |

---

## 4. Developer Workflow & Tooling

### 4.1 Pre-commit hook only lints (HIGH)

[.husky/pre-commit](.husky/pre-commit) runs `lint-staged` + Rust formatting only. Type errors and test failures are caught 5–10 min later in CI.

**Fix:**
```bash
pnpm typecheck || exit 1
pnpm vitest --related --run || exit 1
```

---

### 4.2 Missing package scripts (HIGH/MEDIUM)

```json
{
  "test:watch": "vitest --watch",
  "test:ui": "vitest --ui",
  "clean": "rm -rf dist",
  "clean:rust": "cd src-tauri && cargo clean",
  "clean:all": "pnpm clean && rm -rf node_modules && pnpm clean:rust"
}
```

Note: `CONTRIBUTING.md` references `test:ui` but it's not defined.

---

### 4.3 Frontend test coverage (MEDIUM)

~14 test files against ~150 source files (~9% coverage). Critical untested paths:
- [src/lib/git.ts](src/lib/git.ts) — git wrapper
- [src/lib/project.ts](src/lib/project.ts) — project CRUD
- [src/components/Terminal.tsx](src/components/Terminal.tsx) — PTY interaction

---

### 4.4 No `.env.example` (MEDIUM)

Contributors don't know what env vars are available. Add:
```bash
VITE_LOG_LEVEL=debug
RUST_BACKTRACE=1
RUST_LOG=trace
SHIPSTUDIO_FORCE_ONBOARDING=0
SHIPSTUDIO_FORCE_SETUP=
```

---

### 4.5 No debugging guide (MEDIUM)

[CONTRIBUTING.md](CONTRIBUTING.md) lacks a section on viewing logs, debugging Rust failures, inspecting PTY issues. Add pointers to `~/Library/Logs/ShipStudio/`, `RUST_BACKTRACE=1`, and Cmd+Option+I DevTools.

---

### 4.6 Release process has hidden step (MEDIUM)

`scripts/release.sh` doesn't verify [Changelog.tsx](src/components/Changelog.tsx) was updated. CLAUDE.md mentions this requirement but it's easy to forget → stale "What's New" sidebar.

**Fix:** Add check:
```bash
grep -q "v${NEW_VERSION}" src/components/Changelog.tsx || {
  echo "Error: Changelog.tsx not updated for v${NEW_VERSION}"; exit 1; }
```

Ideally: auto-generate from `RELEASE_NOTES.md`.

---

### 4.7 Manual Rust↔TS type sync (LOW, long-term)

[src-tauri/src/types.rs](src-tauri/src/types.rs) (718 LOC) manually duplicated in TypeScript. Consider [tauri-specta](https://github.com/oscartbeaumont/specta) to auto-generate TS types from Rust command signatures.

---

## Recommended Roadmap

### Quick wins (< 1 day total)
- [ ] Add `test:watch`, `test:ui`, `clean`, `clean:all` scripts
- [ ] Add `typecheck` + `vitest --related --run` to pre-commit hook
- [ ] Create `.env.example`
- [ ] Add changelog check in `release.sh`
- [ ] Create `<Button>`, `<ModalFrame>`, `<EmptyState>`, `<Skeleton>` primitives + `useCopyToClipboard` hook
- [ ] Add `flex-center` utility CSS class
- [ ] Define color, spacing, radius, z-index, shadow token scales in `base.css`

### Week 1–2
- [ ] Replace 52+ hardcoded color instances with CSS variables
- [ ] Build `useAsyncState` + `useInvoke` hooks; migrate 10 components as proof
- [ ] Introduce `CommandError` enum in Rust; migrate `github.rs` + `publishing.rs` first

### Week 3–4
- [ ] Build `ExternalCommand` trait; migrate CLI-heavy modules (`github`, `git`, `vercel`, `ai`)
- [ ] Add `#[tracing::instrument]` to all Tauri commands
- [ ] Introduce `ModalContext`; remove 30+ props from `App.tsx`/`WorkspaceView.tsx`
- [ ] Split `WorkspaceView.tsx`, `ProjectList.tsx`, `PluginManager.tsx`

### Ongoing
- [ ] Incremental CSS token replacement (padding, radius, shadow, z-index)
- [ ] Test coverage: path validation, git ops, project CRUD, terminal — target 20%+ Rust, 25%+ frontend
- [ ] Split monolithic CSS files (`branches.css`, `dashboard.css`)
- [ ] Evaluate `tauri-specta` for type generation

### Future considerations
- [ ] Tailwind migration — only after tokens are consolidated; ROI still moderate
- [ ] Command registration refactor in `lib.rs` — not urgent until >200 commands

---

## Estimated Cumulative Impact

| Category | LOC Reduction | Files Touched | Effort |
|----------|---------------|---------------|--------|
| Frontend primitives + hooks | ~800 LOC | ~60 | 3–4 days |
| CSS token consolidation | ~500 LOC | 37 | 2–3 days |
| Rust CLI trait + CommandError | ~400 LOC | 10+ | 3–5 days |
| Workflow scripts + hooks | — | 5 | < 1 day |
| **Total first pass** | **~1,700 LOC** | **~110** | **~2 weeks** |

No item here is truly "done" — the point is to leave the codebase measurably better each pass. Revisit this report quarterly.
