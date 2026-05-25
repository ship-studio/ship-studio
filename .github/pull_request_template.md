## Summary
<!-- What changed and why. -->

## Test plan
<!-- How you verified the change. -->
- [ ]
- [ ]

<details>
<summary><strong>Patterns checklist</strong> (only relevant if you changed code)</summary>

We use a small set of shared primitives so the codebase stays consistent.
Tick the ones that apply; cross out ones that don't. Full reference:
[CLAUDE.md → How to Do Things in Ship Studio](../CLAUDE.md#how-to-do-things-in-ship-studio).

**Frontend**
- [ ] New modals use `<ModalFrame>` (no hand-rolled overlays / ESC handling)
- [ ] New buttons use `<Button variant=…>` (no new `foo-btn` classes)
- [ ] New async state uses `useAsyncState` / `useInvoke` (no hand-rolled `isLoading` + `error` triples)
- [ ] New polling uses `usePolling` (no raw `setInterval`)
- [ ] Modal state uses `useModal('id')` from `ModalContext` — no new `show*`/`open*`/`close*` triples

**CSS**
- [ ] No raw hex colors, raw `px` spacing, raw z-index numbers, or raw transition durations — use design tokens from `src/styles/global/base.css`
- [ ] New CSS files placed under `src/styles/{global,features,modes,components}/`

**Rust**
- [ ] New `#[tauri::command]`s return `Result<T, CommandError>` and have `#[tracing::instrument]`
- [ ] User-supplied paths validated with `validate_project_path`
- [ ] External CLI calls go through `run_with_timeout` (`src-tauri/src/external_command.rs`)

**Tests**
- [ ] Added tests for non-trivial logic (or noted why not)

</details>
