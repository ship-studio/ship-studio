---
name: ui-harness
description: Look at Ship Studio's actual UI. Boots the real frontend in headless Chrome against a fixture backend and captures screenshots of any app state — dashboard, onboarding, workspace, modals, deploy states — without a Tauri build, a real machine state, or any third-party account. Use whenever you need to check what a screen looks like, verify a UI change, reproduce a state that is awkward to reach for real, or answer "does this look right" instead of guessing from code.
---

# Seeing Ship Studio

You can look at this app. Do that instead of reasoning about the UI from source.

## Run it

```bash
pnpm harness &                             # dev server on 127.0.0.1:1425
node scripts/harness-capture.mjs --all     # ~70 PNGs + harness/shots/report.md
```

Then read `harness/shots/report.md` and open the PNGs you care about. Narrow the
sweep while iterating:

```bash
node scripts/harness-capture.mjs hosting-        # id prefix filter
node scripts/harness-capture.mjs --commands      # palette sweep only
node scripts/harness-capture.mjs --out /tmp/a    # somewhere else
```

The runner exits non-zero if anything crashed, never settled, or asked for a
Tauri command with no fixture.

## The two modes

**Scenarios** (`src/harness/scenarios/`) are hand-written states that are slow
or awkward to reach for real: an empty account, a fresh machine, 24 projects, a
failed deploy, an expired token, merge conflicts. Each carries a
`looksRightWhen` line saying what to check.

**Commands** (`--commands`) sweeps every action registered in the Cmd+K palette,
one page load each. `CLAUDE.md` requires every user-facing feature to register
there, so this list is the app's own inventory and tracks new features
automatically.

## Check the screenshots are of YOUR tree

The runner does this for you: the harness serves `/__harness/identity` and the
capture aborts if the server on the port belongs to a different checkout. If you
see that error, another worktree is holding the port — give yours its own:

```bash
SHIPSTUDIO_HARNESS_PORT=1426 pnpm harness &
SHIPSTUDIO_HARNESS_PORT=1426 node scripts/harness-capture.mjs --all
```

Every `report.md` records the checkout path and HEAD it came from. When you cite
a screenshot as evidence, that line is what makes it evidence rather than an
image. This guard exists because a capture once attached to a neighbouring
worktree's harness and produced a complete, confidently-labelled set of
screenshots of the wrong tree.

## Give every new scenario a `requires`

`requires: '<selector>'` fails the capture when nothing matches. Without it, a
scenario whose surface stopped rendering still yields a clean screenshot of
whatever else was on screen, under that scenario's name. Point it at the thing
the scenario is actually about — the popover, the panel, the list — not at
page chrome that is always present.

## Read the "Text being cut off" section

`report.md` lists elements whose content is wider than the box drawn for it.
Truncation is a few pixels of "…" in a screenshot — easy to read straight past,
and easy to conclude a capture passes when a status line lost its informative
half. Check what got cut, not just that something did. It never fails a run;
some truncation is intended.

## The rule you must not break

**A Tauri command with no fixture is never given a plausible default.** It is
recorded, badged in the UI, and fails the capture run.

If a scenario reports unmocked commands, its screenshot is *incomplete* and is
not evidence. Add the fixture first. Copy the shape from the `invoke<...>` type
at the real call site — including its snake_case/camelCase inconsistency, which
is not uniform across the backend. A fixture that tidies the casing tests a
response the app never receives.

An empty array is fine — "nothing configured yet" is a real backend answer. A
*made-up* value is not.

## Adding a scenario

```ts
{
  id: 'branches-many',
  title: 'Branches — a busy repo',
  looksRightWhen: 'Long names truncate rather than overflow.',
  project: WORKSPACE_PROJECT,                    // open a workspace
  openSelector: '.source-control-push-button',   // click once settled
  clipSelector: '.publish-dropdown-menu',        // capture just this element
  storage: { 'shipstudio.onboardingMode': 'classic' },
  commands: { ...workspaceCommands, list_branches: [...] },
}
```

Register it in `src/harness/scenarios/index.ts`.

Use `clipSelector` for popovers and modals. The harness has no dev server and
no PTY, so the surrounding workspace shows a permanent "Starting dev server…"
spinner and an idle agent pane; clipping keeps those artifacts out of frame.

## What it cannot tell you

- **Nothing about Rust.** Backend logic, path validation, and the git/provider
  adapters have their own `cargo test` suites.
- **Chrome, not WebKit.** Ship Studio ships in a WKWebView. WebKit-specific
  layout bugs will not appear — the CSP/terminal-font gotcha in `CLAUDE.md` is
  the standing example.
- **No real PTY, dev server, or network.** External DNS is blocked so runs are
  hermetic.
- It proves the UI renders a given backend answer correctly. It does not prove
  any backend ever sends that answer.

## Reproducibility

Motion is frozen, storage is wiped per load, external DNS is blocked, and each
capture shoots until two consecutive frames agree. Roughly 80% of captures are
byte-identical across runs; the rest vary in async regions (terminal output,
workspace panel toggles). `report.json` carries `stable` per capture. Do not
treat a byte diff between runs as a regression on its own — look at the image.
