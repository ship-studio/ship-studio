# Ship Studio Development Guidelines

## Feature Overview

Ship Studio is a desktop app for web developers that provides:
- **Project Management** - Create new projects or import existing repos from GitHub
- **Terminal with Claude Code** - Integrated terminal with Claude AI for code assistance
- **Branch Management** - Create, switch, and manage git branches
- **Pull Request Creation** - Submit PRs with AI-generated titles and descriptions
- **Merge Conflict Resolution** - Visual UI for resolving git merge conflicts
- **Asset Management** - Upload, view, and delete files in `/public` folder
- **IDE Integration** - Open projects in VS Code or Cursor with one click
- **Vercel Deployment** - Publish to staging/production via Vercel integration
- **Auto-Updates** - Automatic update detection and installation

## Core Principles

### Never Assume Data
- **Only display data that is reliably known** - never construct, guess, or infer values
- If data isn't available, either:
  1. Don't show that field at all
  2. Show a clear "unknown" or neutral state
  3. Redesign the UI to not need that data
- Example: Don't construct URLs like `https://{project-name}.vercel.app` - only show URLs that were explicitly returned from an API or saved from a real operation
- This prevents confusing users with incorrect information

### Data Storage
- Project metadata is stored in `.shipstudio/project.json` within each project
- This file stores: last_opened timestamp, publish records (staging/production with URL, state, publishedAt)
- Vercel project linking info is in `.vercel/project.json` (managed by Vercel CLI)
- Only trust data that was explicitly saved - don't infer state from file existence alone

## Architecture

### Backend (Rust/Tauri)
- Commands are organized in `src-tauri/src/commands/` by domain (git, vercel, github, etc.)
- Command registration is in `src-tauri/src/lib.rs`
- Commands validate paths to ensure they're within `~/ShipStudio` directory
- Git operations use the `git` CLI with TTL-based caching (`src-tauri/src/cache.rs`)
- Vercel operations use the `vercel` CLI
- Structured logging via `tracing` crate, logs stored at `~/Library/Logs/ShipStudio/`

#### Command Modules
Key command modules in `src-tauri/src/commands/`:
- `ai.rs` - AI-powered PR title/description generation via Claude CLI
- `assets.rs` - File management for `/public` folder (list, upload, delete)
- `claude.rs` - Claude Code binary detection and version checking
- `conflicts.rs` - Merge conflict detection, parsing, and resolution
- `env.rs` - Environment variable management
- `git.rs` - Git operations (status, branches, commits, diffs, stash)
- `github.rs` - GitHub CLI integration (auth status, push, remote management)
- `i18n.rs` - Multilingual config management (Next.js Pages i18n, Astro i18n, next-intl routing.ts) via conservative string surgery — fails with Validation errors instead of guessing
- `ide.rs` - VS Code/Cursor detection and project opening
- `projects.rs` - Project CRUD operations and metadata management
- `pty.rs` - Pseudo-terminal spawning for embedded Claude Code terminal
- `publishing.rs` - Vercel deployment workflow and publish record tracking
- `pull_requests.rs` - PR listing and creation via `gh` CLI
- `setup.rs` - First-run setup, onboarding, and integration checks
- `vercel.rs` - Vercel CLI integration (auth, project linking, domains)

### AI Features
- PR title/description generation using Claude CLI (`src-tauri/src/commands/ai.rs`)
- Frontend wrapper in `src/lib/ai.ts`
- Uses `find_claude_binary()` to locate Claude Code installation
- Gathers git diff, commit messages, branch name, and diff stats as context
- Implements 40KB max diff limit with intelligent truncation at newline boundaries
- Prompts Claude to respond in structured format (`TITLE:` / `DESCRIPTION:`)

### Frontend (React/TypeScript)
- Components are in `src/components/`
- Lib functions (Tauri invoke wrappers) are in `src/lib/`
- Main app state is managed in `src/App.tsx`
- Polling uses exponential backoff (`src/lib/polling.ts`)
- Structured logging via `src/lib/logger.ts`

#### Frontend Libraries
Key modules in `src/lib/`:
- `ai.ts` - AI generation wrapper for PR descriptions
- `assets.ts` - Asset management (list, upload, delete public files)
- `branches.ts` - Branch operations and PR status management
- `claude.ts` - Claude Code detection and availability checking
- `conflicts.ts` - Conflict resolution operations
- `fonts.ts` - Font loading utilities for the terminal
- `git.ts` - Git operations wrapper (status, commits, branches)
- `github.ts` - GitHub operations (auth, push, clone)
- `i18n.ts` - Multilingual support: status/config wrappers, full-ISO language search, locale path helpers for the preview switcher, and agent prompt builders (translate, App Router next-intl setup, removal cleanup)
- `logger.ts` - Structured frontend logging
- `polling.ts` - Exponential backoff utilities for async operations
- `project.ts` - Project metadata and file operations
- `setup.ts` - Setup wizard and integration status
- `updater.ts` - Auto-update functionality and version checking
- `vercel.ts` - Vercel deployment operations

## Testing

### Frontend Tests (Vitest + React Testing Library)
```bash
npm test          # Run all tests
npm run test:ui   # Run with Vitest UI
```

Tests are in `src/**/*.test.{ts,tsx}`. Uses official `@tauri-apps/api/mocks` for mocking Tauri IPC.

### Backend Tests (Rust)
```bash
cd src-tauri && cargo test
```

Unit tests are colocated in source files using `#[cfg(test)]` modules.

### Onboarding / Setup Wizard Testing

Onboarding is critical — it's the first thing every new user sees. There are two ways to test it:

#### 1. Real Mode: `SHIPSTUDIO_FORCE_ONBOARDING=1` (recommended for UI/flow testing)

```bash
SHIPSTUDIO_FORCE_ONBOARDING=1 pnpm tauri dev
```

This forces the onboarding wizard to appear but runs **real system checks**. Items show their actual status on your machine (homebrew, node, git, etc. will show as "ready" with real versions). Terminal-based installs and auth flows work normally.

How it works:
- `quick_setup_check` returns `setup_complete_cached: false` → app shows onboarding
- `get_full_setup_status` returns `all_ready: false` → onboarding stays open
- All individual item checks are real (versions, auth status, etc.)
- `mark_setup_complete` sets an in-memory flag instead of writing to disk
- After completing onboarding, background verification sees real `all_ready: true` → no redirect loop
- Next launch with the env var: onboarding shows again (nothing persisted)

Since your dev machine likely has everything installed, the wizard will auto-advance to the celebration screen. This is correct behavior — it validates the auto-advance logic works.

#### 2. Mock Mode: `SHIPSTUDIO_FORCE_SETUP=<scenario>` (for testing specific states)

```bash
SHIPSTUDIO_FORCE_SETUP=fresh pnpm tauri dev        # Nothing installed (step 1)
SHIPSTUDIO_FORCE_SETUP=auth-only pnpm tauri dev     # Tools installed, no auth (step 2/3)
SHIPSTUDIO_FORCE_SETUP=almost-done pnpm tauri dev   # Only gh_auth missing (step 2)
SHIPSTUDIO_FORCE_SETUP=both-agents pnpm tauri dev   # Everything ready → celebration
SHIPSTUDIO_FORCE_SETUP=codex-only pnpm tauri dev    # Only Codex, no Claude
SHIPSTUDIO_FORCE_SETUP=homebrew,node,git,gh,gh_auth pnpm tauri dev  # Custom: step 3
```

This uses a **mock backend** — item statuses are faked. Clicking "Install" simulates a 2-second install. However, **terminal-based items (homebrew, gh_auth, claude, codex) spawn real processes** that will fail or do unexpected things since they run against your actual system, not the mock.

**When to use which:**
| Scenario | Use |
|----------|-----|
| Testing wizard UI flow and navigation | `SHIPSTUDIO_FORCE_ONBOARDING=1` |
| Testing specific incomplete states | `SHIPSTUDIO_FORCE_SETUP=<scenario>` |
| Testing on a fresh machine (real installs) | No env var needed — onboarding shows automatically |

#### 3. Testing on a Fresh Machine (Real End-to-End)

This is the gold standard test. On a clean macOS install (or a VM):

1. Install Xcode CLI tools: `xcode-select --install`
2. Install Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
3. Install the app (DMG or `pnpm tauri dev`)
4. Walk through every wizard step — verify each install/connect actually works
5. Verify the wizard auto-advances past pre-existing tools
6. Verify celebration screen appears and app loads correctly

**Checklist for fresh machine testing:**

- [ ] Step 1: Homebrew installs successfully via terminal
- [ ] Step 1: Node.js installs after homebrew completes
- [ ] Step 1: npm_fix appears only if ~/.npm has permission issues
- [ ] Step 1: "Next" enables only when all step 1 items are ready
- [ ] Step 2: Git and GitHub CLI install (batch install works)
- [ ] Step 2: GitHub auth opens browser and completes
- [ ] Step 3: Claude Code installs via terminal
- [ ] Step 3: Claude auth flow completes
- [ ] Step 3: "Next" enables when at least one agent pair is ready
- [ ] Step 3: If both agents ready, default agent selection appears inline
- [ ] Step 4: "Skip for Now" advances to celebration
- [ ] Celebration: "You're all set!" shows, auto-continues after 2.5s
- [ ] App: Projects view loads correctly after onboarding
- [ ] Re-launch: Onboarding does NOT show again (setup_complete persisted)

#### Wizard Architecture Quick Reference

The wizard has 4 steps defined in `src/lib/setup.ts` (`WIZARD_STEPS`):

| Step | ID | Items | Complete When |
|------|----|-------|---------------|
| 1 | `package-manager` | homebrew, node, npm_fix | All present items ready |
| 2 | `git-github` | git, gh, gh_auth | All 3 ready |
| 3 | `agent` | claude, claude_auth, codex, codex_auth | At least 1 agent pair ready |
| 4 | `hosting` | *(none)* | Always (placeholder, skippable) |

Key files:
- `src/components/setup/OnboardingScreen.tsx` — wizard orchestrator
- `src/components/setup/WizardStepIndicator.tsx` — step dots
- `src/components/setup/steps/` — per-step components
- `src/lib/setup.ts` — step definitions, helpers, backend API
- `src-tauri/src/commands/setup.rs` — backend setup checks, mock/force modes

## Shared CSS Classes (Plugin-Stable)

These classes are defined in `src/styles/global/base.css` and are part of Ship Studio's public API for plugins. Plugins can use them directly without injecting their own styles. **Do not rename or remove these classes without updating the plugin starter repo.**

| Class | Defined In | Description |
|-------|-----------|-------------|
| `toolbar-icon-btn` | `base.css` | Icon button for the workspace toolbar (32px height, border, rounded corners, hover states). Used by all header action buttons and toolbar plugins. |
| `btn-primary` | `base.css` | Primary action button (accent background, white text) |
| `btn-secondary` | `base.css` | Secondary button (tertiary background, border) |

CSS variables (`--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--text-primary`, `--text-secondary`, `--text-muted`, `--border`, `--accent`, `--action`, etc.) are also stable and available to plugins.

## Common Patterns

### Publishing Flow
1. User clicks Publish in PublishDropdown
2. Backend pushes to GitHub (staging or main branch)
3. Vercel auto-deploys via GitHub integration
4. Result (URL, state, timestamp) is saved to `.shipstudio/project.json`

### Pull Request Flow
1. User clicks "Submit for Review" on a branch
2. SubmitReviewModal opens with branch name as default title
3. User can click "Generate with AI" to auto-generate title/description
4. Backend gathers git context (diff, commits, branch name) and calls Claude CLI
5. PR is created via `gh pr create` with the title and description

### Languages (Multilingual / i18n) Flow
1. Cmd+K → "Languages" opens `LanguagesModal` (`useModal('i18n')`)
2. `get_i18n_status` detects the framework path: Next.js Pages Router (built-in `i18n` in next.config), Astro (`i18n` in astro.config), or App Router via next-intl (`src/i18n/routing.ts`); App Router without next-intl gets a guided one-time agent setup
3. `set_i18n_config` surgically rewrites only the `locales` array and `defaultLocale` string (sibling keys preserved); unparseable/wrapped configs and non-string locale entries fail with a `Validation` error and the UI offers an AI fallback — config is never guessed at or destroyed
4. Every agent interaction (translate, setup, removal cleanup) goes through a prompt-review step: the user sees the exact prompt, then copies it or pastes it into the terminal (nothing runs until they press Enter)
5. The preview toolbar shows a locale switcher (`PreviewLocaleSwitcher`) when 2+ locales are configured; page selection preserves the active language
6. Removal only edits config — translated files stay on disk (and Astro keeps serving locale folders), so the UI warns and offers an AI cleanup prompt

### Conflict Resolution
- Conflicts detected via `git diff --name-only --diff-filter=U`
- ConflictedFile struct contains parsed conflict blocks with context lines
- User resolves conflicts in UI by choosing "ours" or "theirs" for each block
- Resolution written back to file, then auto-staged when all conflicts resolved
- Complete merge commits with message "Resolved merge conflicts via Ship Studio"

### Integration Status
- GitHub: Check via `gh auth status`
- Vercel: Check via `vercel whoami`
- Claude: Check via `claude --version`

## How to Do Things in Ship Studio

These are the canonical patterns. Follow them — a DX refactor established primitives so the same logic isn't re-invented in every component. New code that bypasses these patterns will get flagged in review.

### New modal → use `<ModalFrame>` from `src/components/primitives/ModalFrame.tsx`

Don't hand-roll overlay divs, ESC handling, or close buttons.

```tsx
// ❌ Don't
<div className="my-modal-overlay" onClick={onClose}>
  <div className="my-modal-content" onClick={(e) => e.stopPropagation()}>
    <h3>Title</h3>
    <button onClick={onClose}>×</button>
    ...
  </div>
</div>

// ✅ Do
import { ModalFrame } from './primitives/ModalFrame';

<ModalFrame isOpen={isOpen} onClose={onClose} title="Title">
  {/* body */}
</ModalFrame>
```

For toggling state, pair with `useModalState()` from `src/hooks/useModalState.ts`.

### New button → use `<Button variant="...">` from `src/components/primitives/Button.tsx`

Don't invent per-domain button classes (`foo-btn`, `xyz-action`, etc.) — they fragment the design system.

```tsx
// ❌ Don't
<button className="publish-btn primary" onClick={...}>Publish</button>

// ✅ Do
import { Button } from './primitives/Button';

<Button variant="primary" onClick={...}>Publish</Button>
```

Variants: `primary | secondary | danger | ghost`. Sizes: `md | sm`. Use `block` for full-width.

### Async state in components → use `useAsyncState` or `useInvoke`

Don't hand-roll `isLoading` + `error` + `data` state triples; they forget the mount guard, forget the `finally`, and drift.

```tsx
// ❌ Don't
const [data, setData] = useState(null);
const [isLoading, setIsLoading] = useState(false);
const [error, setError] = useState<string | null>(null);
const load = async () => {
  setIsLoading(true);
  try { setData(await invoke('cmd', {...})); } catch (e) { setError(String(e)); } finally { setIsLoading(false); }
};

// ✅ Do
import { useInvoke } from '../hooks/useInvoke';
const { data, isLoading, error, execute } = useInvoke<ResultType>('cmd');
// call execute({ args }) when ready
```

For non-Tauri promises use `useAsyncState(fn)` directly.

### Calling Tauri commands → prefer `useInvoke` in components

Reserve raw `invoke` calls for `src/lib/*.ts` wrappers. Components should call the wrapper functions (which can internally use `invoke` directly), and when the component needs loading/error state, they should use `useInvoke`.

### Copy-to-clipboard → use `useCopyToClipboard`

Don't call `navigator.clipboard.writeText` directly in components.

```tsx
// ✅ Do
const { copy, isCopied } = useCopyToClipboard({ onCopy: () => showToast('Copied', 'success') });
<button onClick={() => copy(text)}>{isCopied ? 'Copied!' : 'Copy'}</button>
```

### Polling → use `usePolling(fn, { intervalMs, enabled })`

Don't use raw `setInterval` in components — you'll forget the cleanup and you'll skip backoff on error.

```tsx
// ✅ Do
usePolling(async () => refreshStatus(path), { intervalMs: 3000, enabled: isFocused });
```

### CSS values → always use design tokens

The tokens live at the top of [src/styles/global/base.css](src/styles/global/base.css) under a documented block. Never use raw hex colors, raw spacing px, raw z-index numbers, or raw durations.

```css
/* ❌ Don't */
.thing {
  color: #f59e0b;
  padding: 12px 16px;
  border-radius: 8px;
  z-index: 1000;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  transition: background 0.15s ease;
}

/* ✅ Do */
.thing {
  color: var(--warning);
  padding: var(--spacing-md) var(--spacing-lg);
  border-radius: var(--radius-md);
  z-index: var(--z-modal-overlay);
  box-shadow: var(--shadow-md);
  transition: background var(--transition);
}
```

Need a value that doesn't exist yet? Add the token to `:root` in [base.css](src/styles/global/base.css) first, then use it.

### New CSS file → mind the folder structure

CSS lives under this folder structure:

```
src/styles/
├── global/      base.css, typography, utility classes
├── features/    branches/, plugins/, dashboard/, publish/
├── modes/       compact-mode, education-mode
└── components/  modal, tooltip, button
```

Don't dump new files into `src/styles/` root unless they're genuinely cross-cutting.

### New Rust Tauri command → follow the four rules

1. **Return `Result<T, CommandError>`** — see [src-tauri/src/errors.rs](src-tauri/src/errors.rs). Don't return `Result<T, String>`; the frontend can't discriminate error variants.
2. **Validate paths** with `validate_project_path()` from `utils.rs` on any user-supplied filesystem path. Path traversal is a real threat model.
3. **Shell out via `run_with_timeout`** from [src-tauri/src/external_command.rs](src-tauri/src/external_command.rs) — gives you timeouts, structured stderr capture, and extended-PATH spawning for free.
4. **Add `#[tracing::instrument]`** to every command function — even trivial ones. Observability is cheaper than forensics.

### Modal state → use `ModalContext`

Don't add new `show*`/`open*`/`close*` triples to `App.tsx` or `useWorkspaceModals`. Use `useModal('myModalId')` from the `ModalContext` (see [src/contexts/ModalContext.tsx](src/contexts/ModalContext.tsx)); modals read their own open state rather than being passed `isOpen` props.

### New feature → contribute commands via `useCommands`

Every user-facing feature MUST expose its primary actions through the Cmd+K palette. The palette is a contract, not a screen — it's how users discover and invoke features without hunting toolbars.

Commands live next to the handlers that implement them. The pattern is always:

```tsx
// src/commands/useBranchCommands.tsx (or inline in the feature hook)
import { useCommands } from '../commands/useCommands';

export function useBranchCommands({ currentBranch, switchBranch, hasConflicts }: Params) {
  useCommands(
    () => [
      {
        id: 'branches.switch',                      // domain.verb, globally unique
        title: 'Switch branch…',
        icon: <BranchIcon size={14} />,
        category: 'branch',                         // drives tab + grouping
        when: 'project',                            // or (ctx) => boolean
        keywords: ['checkout', 'change'],
        run: () => switchBranch(),
      },
      {
        id: 'branches.resolveConflicts',
        title: 'Resolve merge conflicts',
        category: 'branch',
        when: ({ kind }) => kind === 'project' && hasConflicts,
        run: () => openConflictModal(),
      },
    ],
    [switchBranch, hasConflicts],
  );
}
```

**The six rules:**

1. **`id` is namespaced and globally unique** — format `domain.verb` (e.g. `branches.switch`, `devserver.restart`, `modal.env`). Collisions silently overwrite.
2. **`when` is static or a predicate** — `'home' | 'project'` for the common case, or `(ctx) => boolean` for stateful gating. Evaluated fresh at palette open / state change; never a stale snapshot.
3. **`run` surfaces failures via toast** — silent failures kill palette trust. If a command can fail, `try/catch` and call `showToast(err, 'error')`. Don't assume backend rejections will bubble anywhere visible.
4. **Opening a modal goes through `useOpenModal()`** — from `contexts/ModalContext.tsx`. It returns a stable `(id) => void`. Never reach around to a setter.
5. **Destructive actions need confirmation** — route through the existing confirm-modal pattern. The palette is low-friction by design; guardrails belong on the handler side.
6. **Deps array controls re-registration** — treat it exactly like `useEffect`'s. Missing a dep → stale closure. Too many deps → the bucket rebuilds constantly (no harm, but wasteful).

**Where to put it:**

- For a feature with ≤ 3 commands → call `useCommands` at the bottom of the feature's hook (if it's `.tsx`) or a sibling `useXxxCommands.tsx`.
- For simple modal-opener commands → batch them in `src/commands/useAppCommands.tsx` (already exists).
- For cross-cutting commands (e.g. "Check for updates") → `useAppCommands.tsx`.

**Out of scope for the palette** (don't register these):

- One-shot deep settings (e.g. "Toggle Slack CTA visibility") — leave inside their settings modal.
- Buttons whose label depends heavily on state and where the user is already looking at it (e.g. per-row delete buttons in a list).
- Anything that'd need more than two UI prompts after triggering — build a dedicated flow instead.

See `src/commands/` for the infra (registry, scorer, frecency, `useCommands`) and `src/commands/useAppCommands.tsx` for a canonical example.

---

## Patterns That Are "Out"

These patterns existed in the pre-refactor codebase and are deliberately
avoided now. New code that re-introduces any of them will get caught by
CI (`pnpm check:patterns`, `pnpm check:loc`) and/or a reviewer.

- **Hand-rolled modal overlays** — use `<ModalFrame>`. Re-implementing ESC / click-outside / z-index fights is how accessibility regressions creep back in.
- **Per-domain button classes** (`publish-btn primary`, `rewind-btn`, `xyz-submit`) — use `<Button variant="…">`. Fragmented button CSS is how the design system dies.
- **`isLoading`/`error`/`data` state triples in components** — use `useAsyncState` or `useInvoke`. Hand-rolled triples forget mount guards, forget `finally`, and drift.
- **`onToast?:` prop chains** — use `useOptionalToast()` from `contexts/ToastContext`. Prop drilling for cross-cutting UI.
- **`show*` / `open*` / `close*` state in App.tsx** — use `useModal('id')` from `contexts/ModalContext`. Modals read their own state.
- **Raw `navigator.clipboard.writeText` in components** — use `useCopyToClipboard`. Centralizes error handling and the "copied!" flag.
- **Raw `setInterval` polling** — use `usePolling`. Handles backoff on error and teardown.
- **`Result<T, String>` on `#[tauri::command]` entry points** — use `Result<T, CommandError>` from `src-tauri/src/errors.rs`. String errors can't be discriminated by the frontend.
- **Bare `.output().await` on network CLI calls** — use `run_with_timeout` from `src-tauri/src/external_command.rs`. Unbounded CLI calls can hang the UI forever.
- **Raw hex colors, raw px spacing, raw z-index numbers in CSS** — use tokens from `src/styles/global/base.css`. Adding a new value? Add the token first.

## Known Gotchas

### CSP Must Be Null for Terminal Fonts
The Content Security Policy in `src-tauri/tauri.conf.json` MUST be set to `null`.

**Why:** xterm.js dynamically injects `<style>` elements for font rendering. Even with `style-src 'unsafe-inline'` in the CSP, WebKit/Tauri blocks these styles in production builds. This causes the terminal to fall back to system fonts instead of JetBrains Mono Nerd Font.

**If you change CSP:** Always test terminal font rendering in a production build (`pnpm tauri build`), not just dev mode. Dev mode works fine but production builds will break.

## Releasing New Versions

Use `scripts/release.sh` to automate the release process. The script bumps the version in all 3 files (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`), updates `Cargo.lock`, commits, and tags.

```bash
# Patch bump with release notes (most common)
./scripts/release.sh -n "**Fixed bug X** - Description"

# Minor or major bump
./scripts/release.sh minor -n "**New feature** - Description"

# Then push to trigger CI
git push origin main && git push origin vX.Y.Z
```

The `-n` flag automatically adds notes to `RELEASE_NOTES.md`. Without `-n`, you must update `RELEASE_NOTES.md` manually before running the script.

**IMPORTANT:** Also update the changelog data in `src/components/Changelog.tsx` before each release — it displays "What's New" on the dashboard sidebar.

For Windows builds, tag with a `-win` suffix (e.g. `v0.5.0-win`) — this triggers a separate workflow independent from the macOS pipeline.

See `RELEASING.md` for the full process: secrets, two-repo strategy, auto-update flow, troubleshooting, and Windows release details.
