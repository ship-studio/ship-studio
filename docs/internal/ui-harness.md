# The UI harness — letting an agent see Ship Studio

## What problem this solves

Reviewing Ship Studio used to require a human: launch `pnpm tauri dev`, get the
app into the state you care about, look at it, and describe what you saw. An
agent could read the code and run `pnpm test:run`, but it could not *look* at
the product, so every judgement about whether something works or looks right had
to be relayed by hand.

The harness boots the **real** Ship Studio frontend — real components, real CSS,
real state machines — in headless Chrome against a fixture backend, and captures
it. The only thing replaced is the Tauri IPC boundary.

It is not a replacement for running the Tauri app. It cannot tell you anything
about the Rust backend, WebKit-specific rendering, or the PTY. It tells you what
the UI does with a given backend answer, which is the majority of what review
questions are actually about.

## Using it

```bash
pnpm harness                      # dev server on http://127.0.0.1:1425
node scripts/harness-capture.mjs  # capture every scenario to hosting/shots/
```

`harness-capture.mjs` writes one PNG per scenario plus `report.json`, and exits
non-zero if any scenario crashed. Filter to a subset by prefix:

```bash
node scripts/harness-capture.mjs hosting-
node scripts/harness-capture.mjs dashboard --out /tmp/shots
```

Interactively, open `http://127.0.0.1:1425/harness.html?scenario=<id>`. A
switcher at the bottom lists every scenario and states what the screen is
supposed to look like. Append `&chrome=off` to hide it for a clean capture.

The capture script speaks the Chrome DevTools Protocol over Node's built-in
`WebSocket` and `fetch`. It has no npm dependencies on purpose — Playwright
would add a second browser download and a build step for roughly 200 lines.

## The one rule that makes it trustworthy

**A command with no fixture is never given a plausible default.**

It is recorded, returned as `undefined`, listed in `window.__harness.unhandled()`,
shown as a red badge in the harness chrome, and reported per-scenario by the
capture script. A fake backend that answers everything with `[]` and `true`
produces screenshots that look correct and are meaningless — the exact failure
mode ("never assume data") that the hosting rewrite exists to fix.

So a scenario that reports unmocked commands is *incomplete*, not passing, and
the screenshot from it must not be used as evidence.

## Adding a scenario

Scenarios live in `src/harness/scenarios/`. A scenario is a name, a caption
saying what a reviewer should check, and the commands it overrides on top of
`baseCommands`:

```ts
{
  id: 'hosting-failed',
  title: 'Push popover — build failed',
  looksRightWhen: 'Clearly failed, tied to this commit, no URL offered.',
  project: WORKSPACE_PROJECT,           // open a workspace, not the dashboard
  openSelector: '.source-control-push-button',  // clicked once settled
  clipSelector: '.publish-dropdown-menu',       // capture just this element
  commands: { ...workspaceCommands, get_hosting_status: … },
}
```

Fixture shapes must be copied from the `invoke<...>` type at the real call site,
including its snake_case/camelCase inconsistency. The backend is not uniform
about casing, and a fixture that tidies it up tests a response the app never
receives.

`clipSelector` matters more than it looks: the harness has no dev server and no
PTY, so the surrounding workspace shows a permanent "Starting dev server…"
spinner and an idle agent pane. Clipping to the element under review keeps those
artifacts out of the screenshot.

## Known limitations

- **No backend.** Rust command logic, path validation, and the git/provider
  adapters are not exercised. Those have their own `cargo test` suites.
- **No PTY.** `tauri-pty` is stubbed, so the agent terminal renders its chrome
  and stays inert.
- **No dev server**, so preview panes sit on "Starting dev server…". Expected.
- **Chrome, not WebKit.** Ship Studio ships in a WKWebView. Layout bugs specific
  to WebKit will not appear here — the CSP/font gotcha in `CLAUDE.md` is the
  standing example of a class of bug this cannot catch.
- Scenarios are hand-written. The harness proves the UI renders a given backend
  answer correctly; it does not prove a provider ever sends that answer.

## Files

| Path | Role |
| --- | --- |
| `harness.html`, `vite.harness.config.ts` | Separate entry so nothing leaks into a shipped build |
| `src/harness/main.tsx` | Installs the fake backend, renders the real `<App>`, settles, signals `__harnessReady` |
| `src/harness/fakeBackend.ts` | `mockIPC` router — the same mechanism `src/test/setup.ts` uses |
| `src/harness/unhandled.ts` | The never-assume-data guard |
| `src/harness/scenarios/` | `base` (healthy machine), `workspace` (open a project), `app`, `hosting` |
| `src/harness/stubs/` | Inert `tauri-pty`, screenshots, updater |
| `scripts/harness-capture.mjs` | Headless capture + `report.json` |
