# Ship Studio — Contributing Patterns

Read this first when you join the project (or come back to it after a while).
The TL;DR of the **why** behind the conventions.

## What changed and why

Ship Studio went through a DX refactor that addressed:

- **52+ duplicated modal implementations** — every modal hand-rolled its own
  overlay, ESC handler, close button, and backdrop styling.
- **111 duplicated async-state state pairs** — `useState(false)` for loading +
  `useState<string|null>(null)` for error + a manual try/catch/finally per
  fetcher, repeated everywhere.
- **52+ hardcoded color hexes** in CSS, plus 46 `!important` rules and 15
  unique z-index values.
- **`Result<T, String>` everywhere** in Rust commands — frontend couldn't
  discriminate timeout from auth from validation errors.
- **Missing timeouts** on git commands — `git fetch` could hang the UI
  indefinitely.

The fix was **shared primitives** (UI components + hooks + Rust helpers) that
absorb the boilerplate, plus **design tokens** in CSS and **structured
errors** in Rust. The patterns in [CLAUDE.md → How to Do Things in Ship Studio](../CLAUDE.md#how-to-do-things-in-ship-studio)
are the canonical reference.

## Why this matters for you

If you're adding code:

- **You don't need to invent a modal pattern.** Use `<ModalFrame>`. Five
  minutes saved per modal × N future modals = a lot of saved time.
- **You don't need to reach for `useState` triples.** Use `useAsyncState` /
  `useInvoke`. The mount-guard, the `finally`, the error capture — already
  handled.
- **You don't need to pick a hex color.** Use a `--*` token. If the right
  token doesn't exist, add it to `base.css` once and use it everywhere.
- **You don't need to write a `Result<T, String>` and hope the frontend can
  parse the error string.** Return `Result<T, CommandError>` and the frontend
  gets a tagged object it can branch on.

## Why this matters for AI assistants

If Claude (or another AI) is editing this codebase, it should pattern-match
on the canonical primitives, not on whatever ad-hoc snippet it happens to see
nearby. The reasons:

- Old patterns predate the refactor; copying them forward re-introduces the
  technical debt that was just paid down.
- The lint rules in [eslint.config.js](../eslint.config.js) and the
  `disallowed-methods` in [src-tauri/clippy.toml](../src-tauri/clippy.toml)
  actively warn on regressions — but they're soft-warnings during the
  in-flight migration, so visual review is still the best signal.

When in doubt, check what `<ModalFrame>` / `<Button>` / `useInvoke` /
`useCopyToClipboard` / `usePolling` / `CommandError` / `run_with_timeout`
do, and follow that pattern.

## Where to look

| Layer | File | Purpose |
|---|---|---|
| UI primitives | [src/components/primitives/](../src/components/primitives/) | `ModalFrame`, `Button`, `EmptyState`, `Skeleton` |
| Hooks | [src/hooks/](../src/hooks/) | `useModalState`, `useAsyncState`, `useInvoke`, `useCopyToClipboard`, `usePolling` |
| Contexts | [src/contexts/](../src/contexts/) | `ToastContext` (`useToast` / `useOptionalToast`), `ModalContext` (`useModal`) |
| Design tokens | [src/styles/global/base.css](../src/styles/global/base.css) | All `--*` variables, plugin-stable |
| Rust errors | [src-tauri/src/errors.rs](../src-tauri/src/errors.rs) | `CommandError` enum |
| Rust externals | [src-tauri/src/external_command.rs](../src-tauri/src/external_command.rs) | `run_with_timeout`, `run_to_stdout` |
| TS error mirror | [src/lib/errors.ts](../src/lib/errors.ts) | Tagged union mirroring `CommandError` |

## Where to read more

- **[CLAUDE.md → How to Do Things in Ship Studio](../CLAUDE.md#how-to-do-things-in-ship-studio)** — the canonical don't/do snippets.
- **[CONTRIBUTING.md](../CONTRIBUTING.md)** — getting set up, debugging, log files.
- **[.github/pull_request_template.md](../.github/pull_request_template.md)** — pattern checklist applied to every PR.
