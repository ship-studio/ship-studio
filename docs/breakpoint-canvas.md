# Breakpoint canvas

Every breakpoint at once, side by side, instead of one resizable preview frame.
It is the last option in the preview toolbar's viewport control — the same
segmented control as Desktop/Laptop/Tablet/Mobile, because "all of them" is a
viewport choice rather than a mode on top of one — or Cmd+K → "Show every
breakpoint". A pane too narrow for the icon strip gets the same list from the
overflow button beside refresh: the strip is a choice, not a decoration, so it
is replaced rather than dropped.

Each frame is a real dev-server page. There is no second rendering path: an edit
goes to source and reaches every frame through the dev server's own HMR.

## Whole pages, at an honest viewport height

A frame shows its page **in full** — the frame is as tall as the document, and
you move around the canvas rather than scrolling inside a porthole.

That should not be possible. An iframe cannot report one height and lay out at
another, so a frame tall enough to show a whole page makes `100vh` mean one
*page*: the hero that was written as one screen becomes twenty, which is exactly
what makes a canvas like this useless.

So the units are rewritten instead. When the canvas takes a frame over it tells
it which device it is standing in for, and the injected script resolves that
page's viewport units — `vh`, `svh`, `lvh`, `dvh`, `vmin`, `vmax` — to the
pixels they would have had on that device, in the CSSOM. It is done there rather
than by appending overrides because an override cannot reliably outrank every
selector that might set a height, and CSS has no way to redefine a unit. A
mutation observer re-runs it, because a dev server injects its styles after load
and again on every edit.

Measured on an eight-section test page: the desktop frame is 4907px of page with
a 900px hero; the same page at 375px is 9811px with an 812px hero.

A page can learn how tall its frame is three ways, and all three have to answer
with the device or it lays itself out for a viewport twenty screens tall:

1. **CSS viewport units**, rewritten as above.
2. **Percentage chains.** `html,body{height:100%}` with an `h-full` section under
   it stretches to the frame. The root height is pinned to the device, which
   fixes every percentage at once. Measured on a real page: 9224px reported
   where the page is genuinely 7027px at 1024×700, and the difference was a
   screen and a half of white space in the middle of it.
3. **`window.innerHeight` in JavaScript.** A reveal footer sizing a spacer from
   it is a runaway — the spacer grows, the page gets longer, the frame is
   resized to match, and it grows again, all the way to the 24000px cap. The
   frame answers with the device instead.

There is a fourth, and it is about **width**, which is why it took so long to
find. A frame is a scrollable viewport, and a frame opens at its device height —
which the page overflows until it has been measured. WebKit puts a scrollbar
there, and **subtracts it from the width media queries are evaluated at**: a
1024px laptop frame is asked at 1014px, drops below its own `64rem` breakpoint,
lays itself out taller, the frame grows to match, the scrollbar goes away, and
the breakpoint comes back. A real two-state cycle, and the canvas settles on the
taller member of it. On one marketing page the laptop frame reported 13163px of
page that is genuinely 8527px — 4636px of empty canvas under it, which is what
the bug looked like from the outside.

So the frames are **not scrollable at all** (`scrolling="no"`), which is the
truth anyway: a frame shows its whole page and never scrolls. Hiding the
scrollbar from inside the page does not work — the gutter is reserved before any
stylesheet of the page's gets a say. The fix is host-side, one attribute, and it
moved every frame onto the number the same page measures in Safari: 9596, 8527,
12117 and 10716 for desktop, laptop, tablet and mobile.

Known limits, stated rather than papered over:

- **Height-based media queries** still evaluate against the real (tall) frame.
- **`position: fixed`** pins to the whole page, so a fixed bar appears once
  instead of following the scroll — the same trade a full-page screenshot makes.
- **Hand-rolled lazy loading** (`rect.top < innerHeight` rather than an
  IntersectionObserver) will not reveal past the first screen, because the
  number it asks is the one being lied to. Native `loading="lazy"` and the
  `data-src` convention are released explicitly; IntersectionObserver reads the
  real viewport and is unaffected. Telling the page the truth for a moment was
  tried and rejected — the frame visibly jumps every time, and a height that
  flickers is worse than an image that loads late.
- **Scroll-LINKED motion** (parallax, progress bars) sits at its scroll-zero
  value: the canvas scrolls, the page inside a frame does not. Scroll-triggered
  *reveals* are fine — the whole page is inside the frame's viewport, so they
  all fire, and passive frames complete them instantly.

Because nothing scrolls *inside* a frame any more, there is no scroll to keep in
sync between frames: the canvas itself is what moves.

## A frame is a cross-origin document

Wheel and gesture events that land on a frame are delivered to it, and this
window never sees them. The injected script forwards the ones that belong to the
canvas — zoom gestures, and any wheel the page has no scroll left to spend —
back up with the point they happened at.

## Parts

| Where | What it owns |
|---|---|
| [src/lib/previewCanvas.ts](../src/lib/previewCanvas.ts) | Geometry and zoom maths, no DOM: layout, fit scale, device heights, the mount window, pointer anchoring, zoom stepping |
| [src/components/preview/PreviewCanvas.tsx](../src/components/preview/PreviewCanvas.tsx) | The surface itself: the three layers, what is mounted, the zoom control |
| [src/hooks/useCanvasViewport.ts](../src/hooks/useCanvasViewport.ts) | How big the visible box is — and why measuring the wrong element runs the surface off to millions of pixels |
| [src/hooks/useCanvasFrames.ts](../src/hooks/useCanvasFrames.ts) | The frames as live documents: the registry, what each has been told, how long its page is, what it hands back |
| [src/hooks/useCanvasCamera.ts](../src/hooks/useCanvasCamera.ts) | Where the canvas is looking, and the only thing a gesture moves |
| [src/hooks/useCanvasPlacement.ts](../src/hooks/useCanvasPlacement.ts) | Where the canvas sits and who decided that |
| [src/hooks/useCanvasGestures.ts](../src/hooks/useCanvasGestures.ts) | Wheel, trackpad and keyboard: pan, zoom, and the anchoring correction |
| [src/hooks/useCanvasPan.ts](../src/hooks/useCanvasPan.ts) | Space-drag and middle-drag |
| [src/hooks/usePreviewEditorFrame.ts](../src/hooks/usePreviewEditorFrame.ts) | What the editor, the inspector and screenshots point at |
| [src-tauri/src/proxy/select_script.html](../src-tauri/src/proxy/select_script.html) | The in-frame half: viewport-unit rewriting, page height, gesture forwarding, `ss:selectAt` |

### Three layers, deliberately

The **world** is the only thing a gesture moves: one `translate3d` carrying
everything else. The **scaled layer** inside it holds the pages at their true
CSS widths — the canvas is only visually transformed, so media queries fire at
the labelled width. The **overlay layer** holds labels, frame outlines and the
structural-edit toolbar at screen scale, so they stay legible and crisp at 25%.

The overlay sits inside the world rather than beside it, so a pan carries it
along for free instead of re-rendering it. It is laid out in screen pixels at
the *committed* scale, and while a zoom is in flight the camera scales the whole
layer by the ratio between the live scale and that one — approximately right
mid-pinch, exactly right and crisp the moment it settles.

Anything host-side positioned from a frame's own coordinates has to come through
the canvas scale, and past the label row: the frames start below it, and it is
not scaled. Leaving the label out of the anchor origin drifts a zoom vertically
by exactly `labelHeight × (1 − newScale / oldScale)`.

### A gesture outruns React — so it does not go through it

The canvas **does not scroll**. It used to, and that was the single biggest
thing wrong with how it felt.

A native scroll container puts the position in `scrollLeft` and the zoom in
React state, so every event of a gesture became a render that rewrote
layout-affecting styles — the surface's `width`/`height`, and every frame's
`left`/`top`/`width`/`height` in the overlay — and then wrote `scrollLeft`,
which forces layout synchronously. On a surface holding four live cross-origin
pages that is a full layout per event, tens of times a second, and no amount of
tuning inside that shape makes it feel like a design tool. Design tools do not
do it: during a gesture they move one composited transform and touch nothing
else, and layout happens once, at the end.

So there is a **camera** — `x`, `y`, `scale` — and it lives in a ref:

- Events accumulate and **one animation frame** writes the transforms. Sixty
  events between two frames cost a couple of style writes, not sixty layouts.
- **React is told when the gesture settles** (140ms after the last event). That
  is when the mount window is recomputed and the overlay is laid out crisp. The
  zoom readout is kept truthful in the meantime by writing its text node
  directly, which costs nothing and needs no render.
- `x` and `y` mean exactly what `scrollLeft` and `scrollTop` meant, so every
  piece of geometry in `lib/previewCanvas.ts` — resting position, pointer
  anchoring, the mount window — is unchanged and still describes this camera.

Two traps, both of which have been fallen into and are now guarded by tests:

- **Never adopt the rendered scale merely because it differs from the live
  one.** Mid-gesture they always differ, and the first event of a gesture causes
  a render of its own — so adopting on every render rewinds each gesture to the
  value on screen and the rest of it goes nowhere. It is adopted only when the
  rendered scale actually *changed*.
- **A decision supersedes a gesture that has not settled.** Press Fit within
  140ms of a pinch and the pinch's pending publish would otherwise arrive a beat
  later and undo it. Anything that places a scale outright — Fit, the readout,
  zoom-to-frame — cancels the pending one.

For the same reason the gesture listeners are registered once. A listener set
rebuilt whenever the scale changes throws away the gesture baseline it was
accumulating, and the next event of a pinch already in flight has nothing to
measure itself against.

One consequence worth stating: because the canvas owns the wheel, panning is the
**same code path wherever the pointer is**. It used to be two — the browser
scrolled the container natively when the pointer was over the background, and
the injected script forwarded the wheel by hand when it was over a live frame —
so the canvas changed character as the pointer crossed a frame edge. macOS keeps
delivering wheel events through the momentum phase after the fingers lift, so a
flick still coasts.

### A canvas you cannot lose

The pane's **first** measured size cannot be trusted — a webview commits the
mount before the pane has settled. A canvas that treats its opening position as
a one-off is therefore one bad number away from being parked in the pan slack
for good, which is the grey screen with nothing in it.

Three things prevent it, in order of how much they know:

1. Until the user moves the canvas themselves, it is simply **centred on every
   measurement**. Re-centring is idempotent, so being told the size three times
   costs nothing. A pan, a zoom or a scroll makes the position theirs, and from
   then on a resize compensates by the slack delta instead.
2. The size is read from a `ResizeObserver`, from `window.resize`, and once more
   after the frame the canvas mounted in.
3. Whatever the arithmetic decided, the **laid-out boxes** are checked: if not
   one frame overlaps the visible box, the canvas re-centres. It is measured
   from the DOM rather than from the numbers that produced it, so a wrong number
   cannot also rule that everything is fine.

### One active frame

Exactly one frame is active: it is interactive, the visual editor binds to it,
the inspector listens to it, and screenshots crop to it. The others sit behind a
click-to-activate target, so a stray click in a 30%-scaled frame can't follow a
link or hand the editor an ambiguous target. Clicking one activates it *and*
selects what you pointed at (`ss:selectAt`), rather than spending the click on
activation. Clicking a frame's label brings it up to a workable size.

The editor follows the active frame through `usePreviewEditorFrame`, which hands
the editor hooks a ref whose object identity changes with the frame — that is
what re-runs their setup. Focus mode passes the single preview iframe's own
stable ref, so nothing about it changes.

### Messages

Host → frame: `ss:canvas {on, vh}` — you are part of a canvas, this is the
viewport height to resolve your units against, and hold still — `ss:passive
{on}` — nobody is working in you, so you are a background tab — plus the
editor's existing `ss:*` protocol and `ss:selectAt {x, y}`.

Frame → host: `ss:pageHeight {height}`, `ss:panBy {dx, dy}`, `ss:wheelZoom
{deltaY, x, y}`, `ss:zoomBy {factor, x, y}` (WebKit pinch), and the editor's
existing replies.

A reported page height has to be **measured twice in a row** before it counts,
it may **never be committed twice**, and it is measured from where the content
ends rather than from `scrollHeight`. Three rules, three different failures.

Agreement throws out a transient measured mid-load, which otherwise sticks — a
frame with a screen of white space under a page that got shorter. A
`scrollHeight` on a stretched body just reports the frame's own height back.

And the last two rules catch the frame's own height re-entering the
measurement, which agreement cannot see. The frame is resized to whatever is
reported, so a page that answers to its viewport height answers back — but in
*response to the resize*, which is slower than the sampling, so each value is
comfortably measured twice and agreement is satisfied every time.

It takes two shapes, and only one of them repeats itself.

A **cycle** alternates between two real layouts, A → B → A → B. Returning to a
committed height is that loop exactly, so the visited list ends it, and it
settles on the tallest of the cycle: too tall shows a strip of background, too
short cuts content off, and only one of those loses anything.

A **ratchet** never repeats a value, so a visited list is blind to it. It was
the one that actually bit. Pinning the root height fixes percentage chains
rooted at the root — and does nothing for an absolutely positioned element with
no positioned ancestor, because that resolves against the *initial* containing
block, which is the viewport, which here is the frame about to be resized. Its
bottom is therefore the frame's height, the page measures a constant offset
taller than the frame, the frame grows, and it measures taller again: sixteen
pixels a round, forty rounds, half a minute of a frame visibly resizing before
stopping several hundred pixels too tall — stopping because the write budget ran
out, not because anything was resolved. The cause is removed by making `body` a
containing block, so those elements resolve against the content the way they
would on a real device. The signature is also recognised as a backstop, because
a constant step three times running is not something a settling page does by
accident, and a ratchet settles on the height from *before* the run began —
every step after that is the inflation.

Everything the canvas adds is off until `ss:canvas` arrives, so the ordinary
single-frame preview is left completely alone — including having its gestures
swallowed. A reloaded document starts from that default again, which is why the
frame's `load` handler says it a second time.

## Performance

Four whole pages at once is the expensive thing about this feature, and every
one of these exists because it was measured. On a marketing page in the app, one
ordinary preview frame costs ~20% CPU and ~420MB; four full-length copies of it
came to 64% and 3.3GB before this work and 25% and 1.1GB after. Measured again
later on a heavier page, against the same page in an ordinary single frame: 32%
with the canvas closed, 65% with it open, and the whole of that gap was the one
frame still allowed to animate.

- **Every frame on a canvas holds still** (`ss:canvas`), the active one
  included. This is the single biggest cost in the feature and the one that was
  got wrong first: holding still was treated as the consolation prize for not
  being the active frame, so the active frame — the largest document on the
  canvas — was left animating. On one marketing page with three infinite CSS
  animations, that one exemption **doubled the CPU of the whole preview at
  rest**, 32% → 65%, because a frame here is a WHOLE page: an animation
  anywhere in it repaints every pixel of a ten-thousand-pixel document, forever.
  What an active frame keeps is the right to be edited, which is unrelated.
- **A frame nobody is working in is a background tab** (`ss:passive`): it is
  told it is `hidden` — which is enough for any page that stops its own loops
  — and its `requestAnimationFrame` clock is then suspended, for the pages that
  do not. Callbacks are held rather than dropped, because a rAF loop schedules
  the next frame from inside the current one and discarding them would leave the
  page dead when it came back. Videos are paused. None of it applies for the
  first couple of seconds, so a page's entrance work finishes first.
- **The in-frame observer watches `<head>` for stylesheets**, not the whole
  document for attributes — a class toggled by a scroll animation was scheduling
  a CSSOM walk and a forced layout, in every frame, continuously.
- **Frames outside the mount window are unmounted** (the active one never is),
  so working zoomed into one frame tears down the three you cannot see. Each is
  a full dev-server client with its own HMR socket.
- **The world is promoted for the whole time the canvas is open.** Promoting and
  demoting a layer this size costs a full raster at each end — a hitch at the
  start and the end of every pan — and holding it is what lets a pan be
  composited from the first event of a gesture rather than the second frame of
  it. It was previously toggled per gesture, back when the canvas cost 3.3GB;
  measured now, resident memory is the same with the canvas open and closed.
- **Each stage is `contain: strict`**, so a page reflowing inside one frame does
  not invalidate layout across the canvas.
- **A gesture reaches React once, when it settles** — plus once more mid-pan if
  the camera travels a quarter of a screen, so frames it is heading towards are
  mounted before they arrive.

Everything the canvas adds to a preview page — unit rewriting, page-height
watching, gesture forwarding — is off until `ss:canvas` arrives, so the ordinary
single-frame preview costs exactly what it cost before this feature existed.

## Testing it

`src/lib/previewCanvas.test.ts` covers the geometry and zoom maths;
`src/components/preview/PreviewCanvas.test.tsx` covers frame lifecycle, page
heights, zoom input (including gestures that arrive faster than a render),
panning, re-centring and the editor binding. Its assertions read the camera back
out of the transform the canvas actually wrote, because there is no scroll
position to inspect any more.
`src/components/edit/selectScriptCanvas.test.ts` runs the real injected script
in jsdom and holds it to pinning the root height without touching the site's own
stylesheet or its nested scrollers.

The parts that only exist in a browser — pointer anchoring against real layout,
viewport-unit rewriting, and the injected script's own behaviour — were verified
by mounting the real component over pages served through the same injection the
proxy performs, and driving it: whole pages come back at their real lengths with
their heroes still one screen tall, twelve pinch events inside one frame compound
to the zoom they should and hold their point to under a pixel on both axes, and
every pane size from 368px to 1188px lands with all four frames on screen.
