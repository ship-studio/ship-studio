# Canvas investigation — return handoff to the original agent

> **Resolved 2026-09-05, later the same evening. Read this first.**
> The diagnosis in this document is correct and the measurements below stand.
> The *candidate fix* does not work: the scrollbar CSS added to
> `ssPinRootHeight()` was rebuilt, relaunched and measured in the app, and the
> laptop frame still reported 13163. It has been reverted, and its test rewritten
> to cover what the pin actually does. The working fix is host-side —
> `scrolling="no"` on the canvas frames — and is verified against Safari's
> numbers. See the block at the top of [HANDOFF.md](HANDOFF.md).
> The diagnostic processes and ports listed at the end of this file are all gone;
> the temporary tools under `/private/tmp` may or may not still exist.

Written 2026-09-05, approximately 20:18 EDT. The user explicitly asked to hand
this session back to you. **The root cause is confirmed in the app. A candidate
fix is in source and built, but its behavior in the app is NOT yet verified.
Do not tell the user the canvas is fixed.**

## Worktree and boundaries

Work ONLY in:

```
/Users/juliangalluzzo/Desktop/Projects/shipstudio/.claude/worktrees/breakpoint-canvas
```

Branch `worktree-breakpoint-canvas`. Started from `1e60f5f6` (43 commits ahead of
main). Read `HANDOFF.md`, this file, `CLAUDE.md`, and `docs/breakpoint-canvas.md`.
No push, PR, merge, stash, or changes in the main checkout. This session's work
is being saved as a local WIP commit, not a finished/CI-certified fix.

## Confirmed cause: the scrollbar changes the width breakpoint

We captured the failure TWICE in the actual Ship Studio WebKit app using a
temporary fetch at the beginning of `ssReportPage()`, before the locked guard.
The critical missing measurement was the root's actual width and `matchMedia`,
not just `innerWidth` (which misleadingly stays at 1024 throughout).

One measured run:

| Time from navigation | Measured page height | Last reported height | Root rect width | `(min-width:1024px)` | Locked |
| --- | --- | --- | --- | --- | --- |
| 492ms | 13163 | 0 | 1014 | false | false |
| 1042ms | 8527 | 13163 | 1024 | true | false |
| 1834ms | 13163 | 8527 | 1014 | false | false |
| 2634ms | 8527 | 13163 | 1024 | true | true |

Every row has `window.innerWidth === 1024`. Committed history is
`[13163, 8527]`; the revisit locks at 13163. The body/footer then really ends at
8526.34375, leaving **4636px** of unused frame. The old Chrome comparison's
4562px delta included cross-browser layout differences; 4636px is the actual
within-WebKit discrepancy measured this session.

The ten-pixel scrollbar comes and goes as the frame grows/shrinks. WebKit
subtracts it when evaluating width media queries, so the laptop crosses the
site's 64rem / 1024px responsive threshold. Multiple sections switch layout,
making the page much longer. This is a real two-state layout cycle.

**Neither leading hypothesis in the old handoff is the cause:**

- Replacing the all-time maximum with `max(h, previous)` would STILL choose
  13163. The tall value is a real member of the cycle, not an ancient transient.
- Safari CSSOM inspection found no height-based media conditions on this page.

WebKit's existing issue describes the scrollbar/media-query behavior:
<https://bugs.webkit.org/show_bug.cgi?id=52653>.

The app has global `::-webkit-scrollbar` styling in
`src/styles/global/base.css` around line 138. The Parasail global.css search
found no custom scrollbar styling. The 10px gutter is measured; **whether the
host's scrollbar styling propagates into its frames still needs confirmation**.
The code comment's general site-scrollbar case is valid, but don't describe
Parasail as owning a custom scrollbar without evidence.

## Candidate fix and current files

`src-tauri/src/proxy/select_script.html`, `ssPinRootHeight()` around line 917:

- Add `scrollbar-width:none!important;scrollbar-gutter:auto!important` to the
  existing canvas-only `html` pin.
- Add `html::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}`.
- Keep root overflow visible so the whole page remains rendered.
- Leave nested scrollers alone.
- Do not change the cycle/ratchet logic speculatively.

`src/components/edit/selectScriptCanvas.test.ts` is a new behavior test using
the real injected script in jsdom. It verifies that ordinary preview initially
has no root pin, the canvas overrides root scrollbar/gutter declarations with
priority, nested scrollers retain their styles, root overflow remains visible,
and repeat announcements don't mutate the pin and feed the head observer.

**One focused test passes. It does not prove browser layout behavior.**

Temporary laptop telemetry has been removed from the SOURCE for this handoff.
The RUNNING BINARY still includes it plus the candidate fix. Rebuilding from
the handoff commit will remove the diagnostic fetch. There are no terminal,
React canvas, panning, or palette changes in this candidate.

## Immediate next action

1. Open the Parasail project's **Every breakpoint** canvas in the running app.
   At final inspection the project is open, but the accessibility list did not
   include the canvas zoom controls, and no new laptop trace arrived. Don't
   assume the canvas is currently active just because the project is open.
2. Capture the new laptop trace/readout with the candidate fix. It should have
   root width 1024, `lg: true`, and page height around 8527 throughout. Reload
   several times. Confirm the footer meets the frame bottom, and check all four
   frames, zooming, remounting, and ordinary preview.
3. If root-only CSS doesn't remove the 10px gutter, investigate scrollbar
   styling on the HOST `.preview-canvas-iframe`. The parent's global scrollbar
   rules are a plausible remaining path; don't fall back to picking a shorter
   cycle height (that would keep the wrong breakpoint layout or clip content).
4. Once verified, remove all diagnostic code from the final binary by rebuilding
   and relaunching, run ALL CI gates below, update the design/old handoff to
   reflect the confirmed cause, then commit locally. The pan quality work in
   old HANDOFF §6 is untouched.

## App build and launch — two important warnings

`select_script.html` is still `include_str!`: rebuild AND relaunch.

Fast app-only build used this session:

```bash
pnpm tauri build --debug --bundles app
```

The app bundle and updater archive were built successfully; the command then
returned 1 for the expected missing `TAURI_SIGNING_PRIVATE_KEY`. The initial
full `pnpm tauri build --debug` also built the app, but failed at DMG packaging
inside the sandbox. No DMG is needed for this diagnostic.

**Do not launch the app with the Codex shell's unfiltered environment.** I did
that and the user immediately reported grayscale terminals. The app process
really inherited `NO_COLOR=1`, `TERM=dumb`, and empty `COLORTERM` from this
session. No terminal styling was changed. Relaunch this way:

```bash
osascript -e 'tell application id "com.memberstack.shipstudio" to quit'
env -u NO_COLOR -u FORCE_COLOR -u CLICOLOR TERM=xterm-256color COLORTERM=truecolor \
  open 'src-tauri/target/debug/bundle/macos/Ship Studio.app'
```

Verified after sanitized launch: app PID 63873 had `TERM=xterm-256color`,
`COLORTERM=truecolor`, and no NO_COLOR. Subsequent launch used the same command.
Existing transcript text won't recolor itself; visual recovery in a fresh
agent terminal was NOT separately confirmed. Do not claim it was.

Latest running app at final inspection: **PID 83676**, from this worktree's
debug app bundle. The binary contains `scrollbar-gutter:auto!important` (2
matches through `strings`). It contains the temporary logging too. Before
testing any future change compare process start time with binary mtime as in
old HANDOFF §2. Don't infer freshness from a successful build alone.

## Safari rig findings and tools left available

Safari initially could not load the original rig correctly: the Python triple
quoted `PROBE` string turns JS `join('\n')` into a literal newline inside a JS
string, causing a syntax error. The temporary adapter corrects the evaluated
PROBE with:

```python
PROBE = PROBE.replace("join('\n')", "join('\\n')")
```

The original `~/ShipStudio/.canvas-debug/rig.py` has NOT been edited. After that
repair, Safari at scale .08 measured Desktop 9596, Laptop 8527, Tablet 12117,
Mobile 10716. Laptop committed once; footer bottom 8526.34375; fonts loaded,
no unfinished images, no height media queries. At .36 without the host's global
scrollbar styling, Safari also stayed correct.

Temporary tools, accessible to the next agent while /tmp persists:

- `/private/tmp/canvas-diagnostic.py`: wraps the existing rig, adds timestamped
  samples, DOM/width/media measurements, and POST `/__telemetry` which prints
  JSON to its process stdout. It takes the same three args as rig.py. The file
  now includes `.36` scale and parent `::-webkit-scrollbar{width:10px;height:10px}`.
  Existing processes retain the version from when they started!
- `/private/tmp/canvas-ui.swift` and compiled `/private/tmp/canvas-ui`: fast
  macOS accessibility helper, bound to Ship Studio's bundle identifier.
  `list` prints buttons; passing an exact accessible name presses that control.
  Examples: `"Open parasail-marketing-site"`, `"Fit"`, `"Zoom to Laptop"`.
  Needs desktop/unsandboxed permissions. Plain sandbox calls can silently see
  no accessibility nodes. `parasail-marketing-site` is NOT the dashboard button;
  the full name is `Open parasail-marketing-site`.
- `/private/tmp/canvas-ui.applescript`: older, much slower equivalent. Prefer
  the Swift helper.
- Screenshots: `/private/tmp/canvas-app-before.png` (original 13163 readout),
  `/private/tmp/canvas-app-state.png` (later diagnostic run). Original screenshot
  before reopening the app may show the approval terminal in front; inspect
  images rather than assuming capture focus.

Safari disallows both JavaScript from Apple Events and WebDriver remote
automation in the user's settings. I did NOT change either setting. Safari
can still be navigated using AppleScript, and page-owned JS can POST telemetry.
The built-in preview MCP was not useful for inspecting the app's canvas: it
reported preview inactive even while the canvas was visible. macOS
accessibility worked; Cmd+Option+I did not open the app inspector.

The temporary source telemetry used to confirm the app bug was at the START
of `ssReportPage`, before the `ssPageLocked` early return:

```javascript
if(ssCanvas && window.innerWidth === 1024) try {
  fetch('http://127.0.0.1:8905/__telemetry', {
    method:'POST', mode:'no-cors', body:JSON.stringify({
      appCanvasDiagnostic:true, time:performance.now(), h:ssPageHeight(),
      previous:ssPageH, locked:ssPageLocked, committed:ssPageCommitted,
      width:innerWidth,
      rootWidth:document.documentElement.getBoundingClientRect().width,
      lg:matchMedia('(min-width:1024px)').matches
    })
  });
} catch(err) {}
```

No telemetry goes to a third party. Don't leave this fetch in the final build.
The next agent can't access this turn's tool-session stdout handles. Restart
the local receiver into your own session (or a temporary log) to read new traces.
Don't assume a listening port means its output is available to your session.

Processes present at final inspection (these are all diagnostics I started):

| PID | Port | Purpose |
| --- | --- | --- |
| 48029 | 8903 | original rig, broken readout |
| 50603 | 8904 | first adapter, also before newline repair |
| 53618 | 8905 | repaired adapter + receiver used by app telemetry |
| 63566 | 8906 | .36-scale comparison |
| 82853 | 8907 | candidate fix + parent scrollbar comparison |
| 50054 | 4444 | safaridriver, no session; remote automation disabled |

Re-resolve PIDs/commands before stopping any. It is fine to stop these
diagnostics when no longer needed. Keep the user's app/dev server intact.
Use `cpu.py`, never `ps -o %cpu`, for performance measurements.

## Validation status — work is NOT finished

Passed:

```bash
pnpm exec vitest run src/components/edit/selectScriptCanvas.test.ts
```

Frontend production builds (`tsc && vite build`) and Rust app compilation
passed during diagnostic builds. Existing Vite bundle-size/mixed-import
warnings remained. Full gate suites have NOT been run for this candidate.

Before declaring it complete, run ALL of the original requirements:

```bash
pnpm check:all
pnpm lint:strict
pnpm test:run
pnpm rust:test
pnpm icons:check
pnpm build
```

`check:all` includes typecheck, lint, format, rustfmt, clippy (with the project's
specified allow), script tests, docs, patterns, LOC, and UI baseline; the extra
commands cover strict lint, frontend/backend tests, icons, and build from
HANDOFF §7. No CSS token inventory change is expected: this candidate modifies
injected browser CSS, not consuming app stylesheets or custom properties.

## Other user requests completed during this session

- Removed the global Codex Memberstack MCP via `codex mcp remove memberstack`.
  Confirmed `codex mcp get memberstack` reports no such server. This did not
  remove a Claude MCP or change the terminal's separate authentication warning.
- Set top-level `approval_policy = "never"` in
  `/Users/juliangalluzzo/.codex/config.toml`, verified at line 1. This session's
  existing sandbox/approval restrictions remained active despite that saved
  change. The user is frustrated with repeated approval prompts; don't ask for
  permissions already granted, but obey the actual environment restrictions.

The user explicitly prefers testing in the app and asked for this handoff
before the session limit, rather than more extended investigation here.
