# The UI harness — letting an agent see Ship Studio

## What problem this solves

Reviewing Ship Studio used to require a person: launch `pnpm tauri dev`, get the
app into the state you care about, look at it, and describe what you saw. An
agent could read the code and run `pnpm test:run`, but it could not *look* at
the product — so every judgement about whether something works or looks right
had to be relayed by hand, over and over.

The harness boots the **real** Ship Studio frontend — real components, real CSS,
real state machines — in headless Chrome against a fixture backend, and captures
it. The only thing replaced is the Tauri IPC boundary.

## Using it

```bash
pnpm harness &          # dev server on http://127.0.0.1:1425
pnpm harness:capture    # every scenario + every palette command
```

Output lands in `harness/shots/`: one PNG per capture, plus `report.md` (a
digest meant to be read directly) and `report.json` (the same data structured).
The runner exits non-zero if anything crashed, never settled, or asked for a
Tauri command with no fixture — so it gates CI as well as feeding a review.

```bash
node scripts/harness-capture.mjs                # scenarios only
node scripts/harness-capture.mjs --commands     # palette sweep only
node scripts/harness-capture.mjs hosting-       # filter by id prefix
node scripts/harness-capture.mjs --out /tmp/a   # capture somewhere else
```

Interactively, open `http://127.0.0.1:1425/harness.html?scenario=<id>`. A
switcher at the bottom lists every scenario and states what the screen is
supposed to look like. Useful query parameters:

| Parameter | Effect |
| --- | --- |
| `scenario=<id>` | Which fixture set to load |
| `command=<palette id>` | Run one registered command once the app has settled |
| `project=<path>` | Open a workspace instead of the dashboard |
| `chrome=off` | Hide the harness's own switcher, for a clean capture |
| `freeze=off` | Re-enable animation, for watching a transition by hand |

The capture script speaks the Chrome DevTools Protocol over Node's built-in
`WebSocket` and `fetch`. It has no npm dependencies on purpose — Playwright
would add a second browser download and a build step for roughly this much code.

## Two sources of coverage

**Scenarios** (`src/harness/scenarios/`) are hand-written states that are slow or
awkward to reach for real: an empty account, a fresh machine, 24 projects,
hostile project names, merge conflicts, a failed deploy, an expired credential.
Each carries a `looksRightWhen` caption naming what a reviewer should check, and
that caption is reproduced in `report.md`.

**The palette sweep** (`--commands`) runs every action in the Cmd+K registry, one
page load each. `CLAUDE.md` makes palette registration mandatory for every
user-facing feature, which turns the registry into the app's own inventory of
what a user can do — so this mode tracks the app automatically instead of
drifting from a hand-maintained list of screens. A feature that skips the
palette rule shows up as a coverage gap rather than quietly going unseen.

Commands are enumerated separately in the home and project contexts, because the
palette gates on where you are. Non-visual and navigational commands are skipped
via `SKIP_COMMANDS` in the runner, and every skip is listed in the report so the
list cannot quietly hide a broken feature.

## Provenance: which tree did these screenshots come from?

The capture runner refuses to screenshot a harness that is serving a different
checkout, and every report records the checkout path and HEAD it came from.

This exists because of a real failure. The runner originally checked only that
*something* answered on the harness port. On a machine running several
worktrees — four agent sessions and five worktrees, on the day this was
written — a capture attached to a neighbour's harness, screenshotted their
tree, and wrote seventy-one green checkmarks plus a report captioned with
*this* checkout's scenario names. Real images, wrong tree, no warning. Someone
was one screenshot away from reporting ten deployment states verified against a
build that did not contain the feature.

That is worse than any bug the harness was built to catch, because every other
failure here is loud: a missing fixture badges red, a crash fails the run, an
unsettled frame is marked unstable. This one wrote ✓.

So the harness now serves `/__harness/identity` (absolute repo root + git HEAD)
and the runner compares it against the directory it was invoked from, aborting
with both paths named. Two shapes of failure are caught: a server that cannot
answer the endpoint at all (stale, or unrelated), and one that answers with a
different root.

To run harnesses from several worktrees at once, give each its own port:

```bash
SHIPSTUDIO_HARNESS_PORT=1426 pnpm harness &
SHIPSTUDIO_HARNESS_PORT=1426 node scripts/harness-capture.mjs --all
```

`strictPort` is deliberately still on: a harness that silently moved to another
port would reintroduce exactly the ambiguity this section is about.

## The one rule that makes it trustworthy

**A command with no fixture is never given a plausible default.**

It is recorded, returned as `undefined`, listed in `window.__harness.unhandled()`,
shown as a red badge in the harness chrome, and reported per-capture. A fake
backend that answers everything with `[]` and `true` produces screenshots that
look correct and are meaningless — the exact "never assume data" failure that
the hosting rewrite exists to fix.

So a capture that reports unmocked commands is **incomplete, not passing**, and
its screenshot must not be used as evidence.

An empty array is a legitimate fixture: "nothing configured yet" is a real
backend answer. An invented value is not. That is the line.

## Adding a scenario

```ts
{
  id: 'branches-many',
  title: 'Branches — a busy repo',
  looksRightWhen: 'Long branch names truncate rather than overflow.',
  project: WORKSPACE_PROJECT,                    // open a workspace
  openSelector: '.source-control-push-button',   // clicked once settled
  clipSelector: '.publish-dropdown-menu',        // capture just this element
  storage: { 'shipstudio.onboardingMode': 'classic' },
  commands: { ...workspaceCommands, list_branches: [...] },
}
```

Register it in `src/harness/scenarios/index.ts`.

Fixture shapes must be copied from the `invoke<...>` type at the real call site,
**including its snake_case/camelCase inconsistency** — the backend is not
uniform about casing, and a fixture that tidies it up tests a response the app
never receives. (`get_conflict_info` returns snake_case; `get_full_setup_status`
returns camelCase. Both are correct.)

Fixture layering:

| Layer | Contents |
| --- | --- |
| `base.ts` | A healthy, fully set-up machine; everything reachable from anywhere |
| `workspace.ts` | What opening a project asks for |
| `app.ts` | Dashboard and onboarding scenarios |
| `features.ts` | Populated branches, PRs, conflicts, workflows, inbox |
| `hosting.ts` | The ten push-popover deployment states |

Put a fixture in `base.ts` if the surface opens from the dashboard *and* from a
project — Help, Skills and MCP all do, and a fixture that exists only in the
workspace layer white-screens the dashboard path.

Use `clipSelector` for popovers and modals: the harness has no dev server and no
PTY, so the surrounding workspace shows a permanent "Starting dev server…"
spinner and an idle agent pane. Clipping keeps those artifacts out of frame.

## Reproducibility

A screenshot you cannot diff is not much use, so the harness works at being
deterministic:

- **Storage is wiped** before any app module reads it (`resetStorage.ts`),
  because captures share one Chrome profile and a preference written by an
  earlier capture would silently change a later one.
- **Motion is frozen** (`freeze.css`): animations, transitions, the xterm cursor
  and OverlayScrollbars thumbs.
- **External DNS is blocked**, so components that fetch the real internet (the
  GitHub contributions calendar) cannot make a run depend on the network.
- **Readiness is IPC quiescence**, not a fixed delay — the app has stopped
  asking the backend for things.
- **Each capture shoots until two consecutive frames agree**, and records
  `stable` in the report if it never settled.

About 80% of captures are byte-identical across runs. The rest vary in genuinely
async regions — terminal output, and the workspace panel toggles, which settle
open or closed differently between identical loads. Treat a byte difference
between two runs as a prompt to look at the image, not as a regression by
itself.

## What it cannot tell you

- **Nothing about Rust.** Backend logic, path validation and the git/provider
  adapters are not exercised; those have their own `cargo test` suites.
- **Chrome, not WebKit.** Ship Studio ships in a WKWebView. WebKit-specific
  layout bugs will not appear here — the CSP/terminal-font gotcha in
  `CLAUDE.md` is the standing example of a class of bug this cannot catch.
- **No PTY, no dev server, no network.**
- It proves the UI renders a given backend answer correctly. It does not prove
  that any provider or backend ever sends that answer.

## Files

| Path | Role |
| --- | --- |
| `harness.html`, `vite.harness.config.ts` | Separate entry so nothing leaks into a shipped build |
| `src/harness/main.tsx` | Installs the fake backend, renders the real `<App>`, settles, signals `__harnessReady` |
| `src/harness/resetStorage.ts` | Wipes/seeds storage before app modules load |
| `src/harness/fakeBackend.ts` | `mockIPC` router + IPC-quiescence signal |
| `src/harness/unhandled.ts` | The never-assume-data guard |
| `src/harness/commandBridge.ts` | Reads and runs the Cmd+K registry |
| `src/harness/freeze.css` | Capture determinism |
| `src/harness/scenarios/` | The fixture layers above |
| `src/harness/stubs/` | Inert `tauri-pty`, screenshots, updater |
| `scripts/harness-capture.mjs` | Headless capture, identity guard, `report.md`, `report.json` |
| `.claude/skills/ui-harness/SKILL.md` | So an agent discovers this without being told |
