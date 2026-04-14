## Summary
<!-- What changed and why. -->

## Test plan
<!-- How you verified the change. -->
- [ ]
- [ ]

## Pattern checklist

See [CLAUDE.md → How to Do Things in Ship Studio](../CLAUDE.md#how-to-do-things-in-ship-studio) for the canonical patterns. Tick the ones that apply; strike through ones that don't.

**Frontend**
- [ ] New modals use `<ModalFrame>` (no hand-rolled overlays / ESC handling)
- [ ] New buttons use `<Button variant=…>` (no new `foo-btn` classes)
- [ ] New async state uses `useAsyncState` / `useInvoke` (no hand-rolled `isLoading` + `error` triples)
- [ ] New polling uses `usePolling` (no raw `setInterval`)
- [ ] New clipboard use goes through `useCopyToClipboard`
- [ ] Modal state uses `useModal('id')` from `ModalContext` — no new `show*`/`open*`/`close*` triples

**CSS**
- [ ] No raw hex colors in new rules (use `var(--warning)` etc.)
- [ ] No raw `px` spacing values (use `var(--spacing-*)`)
- [ ] No raw z-index numbers (use `var(--z-*)`)
- [ ] No raw transition durations (use `var(--transition*)`)
- [ ] New CSS files placed under `src/styles/{global,features,modes,components}/` per the folder plan

**Rust**
- [ ] New commands return `Result<T, CommandError>`
- [ ] User-supplied paths validated with `validate_project_path`
- [ ] External CLI calls go through the `ExternalCommand` trait
- [ ] Every command has `#[tracing::instrument]`
- [ ] `unwrap`/`expect` not introduced in `commands/*`

**Tests**
- [ ] Added tests for new Rust commands (or noted why not)
- [ ] Added tests for non-trivial frontend logic
- [ ] Tests actually exercise real behavior (avoid pure mocks where the migration-risk lives)
