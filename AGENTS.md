# Agent instructions for Ship Studio

The full agent-facing guide for this codebase is **[CLAUDE.md](CLAUDE.md)** —
read it before writing code. It covers the architecture, the canonical
patterns ("How to Do Things in Ship Studio"), the patterns that are banned,
testing, and known gotchas. This file is just the contract in brief.

## Non-negotiables

1. **Run the CI gates before declaring work done:**
   ```bash
   pnpm check:all     # typecheck + lint + prettier + rustfmt + clippy + pattern/LOC checks
   pnpm test:run      # frontend tests (Vitest)
   pnpm rust:test     # backend tests (cargo test)
   ```
2. **Use the shared primitives** — `<ModalFrame>`, `<Button variant=…>`,
   `useInvoke`/`useAsyncState`, `usePolling`, `useCopyToClipboard`,
   `useModal('id')`. Hand-rolled equivalents are rejected by
   `pnpm check:patterns` and reviewers. See
   [docs/CONTRIBUTING_PATTERNS.md](docs/CONTRIBUTING_PATTERNS.md).
3. **CSS uses design tokens only** (top of `src/styles/global/base.css`) —
   no raw hex colors, px spacing, z-index numbers, or durations. Need a new
   value? Add the token first.
4. **New Rust commands**: return `Result<T, CommandError>`, validate paths
   with `validate_project_path()`, shell out via `run_with_timeout`, and add
   `#[tracing::instrument]`.
5. **Every user-facing feature registers its actions in the Cmd+K palette**
   via `useCommands` (see CLAUDE.md → "New feature → contribute commands").
6. **Never assume data** — only display values that were explicitly returned
   or saved; never construct URLs or infer state from file existence.

## Layout in one breath

React/TS frontend in `src/` (components, `lib/` invoke-wrappers, hooks,
`commands/` palette) · Rust/Tauri backend in `src-tauri/src/commands/` by
domain · CSS in `src/styles/{global,features,modes,components}/` · tests
colocated (`*.test.tsx`, `#[cfg(test)]`).
