# Breakpoint canvas — handoff

Written 2026-09-05 by the previous agent. One open bug, one open quality gap,
and the rig you need to work on either without guessing. Read §1 and §7 before
touching anything.

---

## 1. Where to work

**Work in the git worktree, not the main checkout:**

```
/Users/juliangalluzzo/Desktop/Projects/shipstudio/.claude/worktrees/breakpoint-canvas
```

- Branch: `worktree-breakpoint-canvas`, **42 commits** ahead of `main`
- Rebased onto `origin/main` = `27fb7b41`
- Working tree clean, everything committed, **nothing pushed** (see §7)
- The main checkout at `~/Desktop/Projects/shipstudio` is a *different* worktree
  on `main`. Do not `cd` there. Run every command from the path above.
- The git stash stack is shared across worktrees and other agents may be using
  it. Do not use bare `git stash` / `git stash pop`. Use a WIP commit instead.

The feature's own design notes are [docs/breakpoint-canvas.md](docs/breakpoint-canvas.md)
— read that first, it explains *why* the odd-looking parts are the way they are.
A summary is in [CLAUDE.md](CLAUDE.md) under "Breakpoint Canvas Flow".

## 2. Build and run — the gotcha that will waste your afternoon

The in-frame half of this feature is `src-tauri/src/proxy/select_script.html`,
pulled into the Rust binary at **compile time**:

```rust
// src-tauri/src/proxy/mod.rs:89
const SELECT_SCRIPT: &str = include_str!("select_script.html");
```

Ship Studio's own proxy injects it into every HTML response it serves from the
user's dev server. Consequences:

- **Editing that file changes nothing until you rebuild AND relaunch the app.**
- Restarting the project's dev server does nothing — the dev server never sees
  this script.
- Reloading the preview does nothing.
- A running app keeps the script it was compiled with. I wasted a long stretch
  reporting "fixed" against an app that was six hours stale. **Always check:**

```bash
pgrep -f "bundle/macos/Ship" | xargs ps -o pid=,lstart= -p
stat -f "%Sm" "src-tauri/target/debug/bundle/macos/Ship Studio.app/Contents/MacOS/ship-studio"
```

The app's start time must be *after* the binary's build time.

Rebuild (~2 min; the bundle is produced before the signing step, so the
`TAURI_SIGNING_PRIVATE_KEY` error at the end is harmless):

```bash
pnpm tauri build --debug
open "src-tauri/target/debug/bundle/macos/Ship Studio.app"
```

Verify a change actually landed in the binary:

```bash
strings -a "src-tauri/target/debug/bundle/macos/Ship Studio.app/Contents/MacOS/ship-studio" | grep -c "yourNewSymbol"
```

## 3. The one open bug — the laptop frame over-measures

**Symptom:** one frame (consistently the laptop, 1024px) reports a page height
far larger than the page, so the canvas shows hundreds or thousands of pixels of
empty background below the content. The user reported it as "some canvases are
just randomly getting a bunch of space added to them."

**Hard data.** Same page (`parasail-marketing-site`, Astro dev server on
`localhost:3950`), same injected script, measured at the same time:

| frame | rig in Chrome | Ship Studio (WebKit) | delta |
|---|---|---|---|
| Desktop 1440 | 9614 | 9576 | −38 |
| **Laptop 1024** | **8601** | **13163** | **+4562** |
| Tablet 768 | 12141 | 12243 | +102 |
| Mobile 375 | 10754 | 10716 | −38 |

Three frames agree within ~1%. The laptop is 53% too tall. In the Chrome rig I
also walked the DOM and confirmed the reported height is *exactly* the bottom of
the deepest visible element (8601 reported vs 8600 measured, deepest element
`FOOTER.bg-(--footer-bg)`), so the measurement logic is right when it is right.

**What is already ruled out** (all fixed and verified this session, see §4):
the head-observer self-feeding loop, the initial-containing-block ratchet, the
double-counted body top margin, sticky elements, and viewport units inside
nested CSS rules. None of those explain a Chrome/WebKit divergence.

**Leading hypotheses, in order:**

1. **A bad early value got committed and then locked.** `ssReportPage`
   (select_script.html, ~line 990) locks on a *revisit* and settles on
   `tallest`. If a mid-load transient of 13163 is committed, and the height
   later cycles back to it, the lock picks the tallest — 13163 — permanently.
   Under load (four frames plus the app, on WebKit, versus one idle Chrome tab)
   transients are far more likely, which would explain the engine divergence
   without the engine being the cause. **If this is it, the fix is that a
   revisit should settle on `max(h, previous commit)` — the two members of the
   actual cycle — rather than the all-time tallest, which can resurrect an
   ancient transient.** This is my best guess and the cheapest to test.
2. **A height-based media query.** `@media (min-height: …)` still evaluates
   against the real (tall) frame — a known, documented limit that is also a
   *feedback* path: the query flips, the layout changes, the height changes, the
   frame resizes, the query flips back. Laptop has the shortest device height
   (700px) so it has the widest gap between "laid out like a desktop" and
   "told it has a short screen". **A real fix exists and would also close the
   documented limitation:** rewrite media *conditions* in the CSSOM the same way
   viewport units are rewritten — walk `CSSMediaRule`s, evaluate `min-height` /
   `max-height` against `ssVH` yourself, and replace that clause with
   `(min-height: 0px)` for true or `(max-height: 0px)` for false via
   `rule.media.mediaText`. It is idempotent and leaves the rest of the condition
   intact. I did not implement it because I had not confirmed it is the cause.
3. Something genuinely WebKit-specific in `getBoundingClientRect` under a
   scaled, `contain: strict` ancestor. Least likely; nothing supports it yet.

**The next diagnostic, which I set up but ran out of time on.** Serve the same
page through the rig and open it *in Safari* (same engine as the app) rather
than Chrome. If Safari shows 13163, it is engine-specific and you can iterate in
seconds instead of two-minute rebuilds. If Safari shows 8601, it is timing or
load-related and hypothesis 1 is almost certainly right. The rig already renders
a visible readout of every committed height with timestamps, so a screenshot is
enough — you do not need devtools. See §5.

The single most informative thing you can add: log **every** committed height
with a timestamp for the laptop frame, and look at the shape of the sequence.
A monotone walk with a constant step is a ratchet (a leak that is still open);
a value that jumps to 13163 once and sticks is hypothesis 1.

## 4. What was fixed and verified (do not re-litigate these)

All measured, not assumed.

- **The settle observer fed itself.** It watched `<head>` for stylesheets, and
  the work it did in response wrote a `<style>` into that head unconditionally,
  so every pass scheduled the next — forever, in all four frames, each pass
  invalidating every style in the document and forcing a layout of a ~10,000px
  page. Measured 20s after load with nothing happening: **13 passes per frame →
  0**. A second audit reproduced it in jsdom (15 self-triggered passes in 3s).
- **The ratchet.** Pinning the root height does nothing for an absolutely
  positioned element with no positioned ancestor: it resolves against the
  *initial* containing block, which is the viewport, which here is the frame
  about to be resized. `body` is now a containing block. Settle time on
  `native-website`: **24–30s and up to 40 commits → one commit per frame within
  2.2s**.
- **Idle CPU in the app**, measured with CPU-time deltas: **56.6% → 1.6%**,
  RSS 1207MB → 847MB. For reference the ordinary single-frame preview is 2.6% —
  the canvas is now cheaper than it, because on a canvas every frame holds still.
- **Every frame on a canvas holds still** (`ss:canvas`), not just inactive ones;
  inactive frames additionally get background-tab semantics (`hidden` reported,
  rAF suspended, held not dropped). Honest note: this measured as *close to
  nothing* on its own — the head loop was drowning it. Keep it, but it is not
  what fixed the CPU.
- **Zoom no longer strands the frames.** When a zoom settles and the content
  fits an axis, that axis recentres; the other axis is left alone, and a
  deliberate pan is never overridden.
- **The canvas is hidden until its frames know their heights**, with a 3s
  deadline so a dead page cannot hold it blank.
- Middle-drag and shift+wheel now work over the active frame (it forwards them,
  because a cross-origin iframe swallows the events the host binds).
- Editor label column 72px → 88px (`--editor-panel-label-w`): "Letter spacing"
  is 76px at 11px and "Justify content" is 79px, so both were truncating.

**Not yet verified in the running app:** everything in the final commit
(`2ca2a5fd`) — the reveal gate, the mouse-pan forwarding, the label width. They
are green in tests but the app has not been rebuilt and relaunched since.

## 5. How to measure — use these, do not eyeball

Two tools, kept at `~/ShipStudio/.canvas-debug/`:

**`rig.py`** — serves any dev server through the *same injection the Ship Studio
proxy performs*, plus a same-origin four-frame canvas harness at `/__probe` that
drives the real protocol (`ss:canvas`, `ss:passive`) and resizes each iframe to
whatever height it reports. Because it is same-origin, you can inspect straight
into the frames, which you cannot do in the app.

```bash
python3 ~/ShipStudio/.canvas-debug/rig.py http://localhost:3950 \
  "$PWD/src-tauri/src/proxy/select_script.html" 8903
# then open http://127.0.0.1:8903/__probe
```

It takes the script path as an argument, so you can A/B two versions on two
ports at once — e.g. `git show HEAD~1:src-tauri/src/proxy/select_script.html`
into a temp file and serve it on 8901. The page shows a live readout of every
committed height with timestamps (works in Safari, where you cannot run
devtools through automation), and `window.RIG.report()` returns per-frame state
(`still`, `raf`, `visibility`, heights) from the main world.

Note the rig proxies every asset through Python, so it is much slower to load
than the Rust proxy. Give it 40-75s to settle before believing a number.

**`cpu.py`** — instantaneous CPU as a delta of cumulative CPU time.

```bash
python3 ~/ShipStudio/.canvas-debug/cpu.py "label" <pid> 12
```

> **`ps -o %cpu` on macOS is a LIFETIME AVERAGE, not current usage.** I reported
> a "canvas doubles CPU, 32% → 65%" result from it that was an artifact and sent
> myself down a wrong path for an hour. Never use it for this. Use `cpu.py`, or
> `top -l 2` and read the second sample.

The render process to measure is the WebKit content process, not the app:
`pgrep -f "com.apple.WebKit.WebContent"` — pick the one whose start time matches
the app's.

## 6. The open quality gap — "less fluid than Figma"

Real, and not yet addressed. The user's words: "significantly less fluid than
Figma. Is there any little secret?" What I know:

- **There are two different pan paths on one canvas.** Inactive frames are
  covered by a host-side activation button, so the wheel bubbles to the scroll
  container and macOS scrolls it *natively* — scrolling thread, inertia,
  rubber-band. The active frame is a live cross-origin iframe, so it swallows
  the wheel; the injected script forwards it by `postMessage` and the host
  writes `scrollLeft/scrollTop` on the **main thread**. No inertia, no
  rubber-band, and it shares a thread with painting. Panning therefore feels
  different depending on which frame the pointer is over.
- **The structural difference from Figma** is that Figma scales a texture and we
  scale four live documents, so a zoom re-rasterizes them.
- **The cheapest thing I would try next** (untested): `will-change: transform`
  on `.preview-canvas-scaled` is currently toggled by an `is-interacting` class
  with a 300ms tail (`preview-canvas.css`, `useCanvasPlacement.ts`). Promoting
  and demoting a layer that large on *every* gesture costs a full raster at each
  end — a hitch at the start and end of every pan. Now that idle CPU is 1.6% and
  memory is down to 847MB, try holding the promotion for the whole time the
  canvas is open and measure both smoothness and RSS. The existing comment in
  the CSS argues against holding it; that argument was written when the canvas
  cost 3.3GB and may no longer hold.
- The structural alternative for the pan-path split is to put a transparent
  host-side surface over the active frame too, so the wheel is always native and
  clicks are translated through `ss:selectAt` (which already exists — it is how
  clicking an inactive frame selects what you pointed at). The cost is that live
  hover-highlighting inside the active frame would need rethinking. I did not do
  this because the main-thread contention was the more likely cause and that is
  now largely gone; re-measure before redesigning.

## 7. Ground rules

- **Do not push, open a PR, or merge.** The user's standing instruction is that
  nothing leaves the machine without explicit per-action approval in the message
  where they give it. Local commits are fine and expected.
- Do not run heavy test rigs while the user is judging performance — I did, and
  it made their app feel worse and muddied their impression of a fix.
- CI equivalents, all currently green: `pnpm typecheck`, `pnpm lint:strict`,
  `pnpm format:check`, `pnpm test:run` (2174 pass), `pnpm test:scripts`,
  `pnpm icons:check`, `pnpm docs:check`, `pnpm check:ui-baseline`,
  `pnpm check:patterns`, `pnpm check:loc`, `pnpm build`,
  `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`,
  `cargo clippy --manifest-path src-tauri/Cargo.toml -- -A clippy::uninlined_format_args`,
  `cargo test --manifest-path src-tauri/Cargo.toml` (1176 pass).
- Touching CSS custom properties? Run `pnpm tokens:inventory` or
  `check:patterns` fails on a stale inventory.
- **No literal `<head` or `<html` may appear anywhere in `select_script.html`,
  comments included.** The proxy splices its head-start snippet at the first such
  string in the whole response, so one in a comment captures the splice. There
  is a Rust test guarding this.

## 8. Known limits (deliberate, documented, not bugs)

In `docs/breakpoint-canvas.md`: height-based media queries evaluate against the
tall frame (see §3 hypothesis 2 for how to close this), `position: fixed` pins
to the whole page, hand-rolled lazy loading that reads `innerHeight` will not
reveal past the first screen, and scroll-*linked* motion (parallax, progress
bars) sits at its scroll-zero value because the canvas scrolls and the page
inside a frame does not.
