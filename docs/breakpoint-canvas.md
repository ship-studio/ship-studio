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
| [src/components/preview/PreviewCanvas.tsx](../src/components/preview/PreviewCanvas.tsx) | The surface itself: two layers, what is mounted, the zoom control |
| [src/hooks/useCanvasViewport.ts](../src/hooks/useCanvasViewport.ts) | How big the visible box is — and why measuring the wrong element runs the surface off to millions of pixels |
| [src/hooks/useCanvasFrames.ts](../src/hooks/useCanvasFrames.ts) | The frames as live documents: the registry, what each has been told, how long its page is, what it hands back |
| [src/hooks/useCanvasPlacement.ts](../src/hooks/useCanvasPlacement.ts) | Where the canvas sits and who decided that |
| [src/hooks/useCanvasZoom.ts](../src/hooks/useCanvasZoom.ts) | Every way to zoom, and the anchoring correction |
| [src/hooks/useCanvasPan.ts](../src/hooks/useCanvasPan.ts) | Space-drag and middle-drag |
| [src/hooks/usePreviewEditorFrame.ts](../src/hooks/usePreviewEditorFrame.ts) | What the editor, the inspector and screenshots point at |
| [src-tauri/src/proxy/select_script.html](../src-tauri/src/proxy/select_script.html) | The in-frame half: viewport-unit rewriting, page height, gesture forwarding, `ss:selectAt` |

### Two layers, deliberately

The **scaled layer** holds the pages at their true CSS widths — the canvas is
only visually transformed, so media queries fire at the labelled width. The
**overlay layer** is unscaled and holds labels, frame outlines and the
structural-edit toolbar, so they stay legible and crisp at 25%.

Anything host-side positioned from a frame's own coordinates has to come through
the canvas scale, and past the label row: the frames start below it, and it is
not scaled. Leaving the label out of the anchor origin drifts a zoom vertically
by exactly `labelHeight × (1 − newScale / oldScale)`.

### A gesture outruns React

A trackpad delivers a pinch far faster than the canvas re-renders. Nothing in
the zoom path may therefore read the zoom level from a render: the live scale is
a ref, each event compounds on the one before it, and the scroll correction that
holds the point under the pointer chains the same way. Measuring each event
against the last *rendered* scale collapses a whole gesture into its final
event, which is what a canvas that "barely zooms" is doing.

For the same reason the gesture listeners are registered once. A listener set
rebuilt whenever the scale changes throws away the gesture baseline it was
accumulating, and the next event of a pinch already in flight has nothing to
measure itself against.

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

Host → frame: `ss:canvas {on, vh}` — you are part of a canvas, and this is the
viewport height to resolve your units against — `ss:passive {on}` — nobody is
working in you, hold still — plus the editor's existing `ss:*` protocol and
`ss:selectAt {x, y}`.

Frame → host: `ss:pageHeight {height}`, `ss:panBy {dx, dy}`, `ss:wheelZoom
{deltaY, x, y}`, `ss:zoomBy {factor, x, y}` (WebKit pinch), and the editor's
existing replies.

A reported page height has to be **measured twice in a row** before it counts,
and it is measured from where the content ends rather than from `scrollHeight`.
Neither is fussiness: the frame is resized to whatever is reported, so a page
whose layout answers to its own viewport height oscillates unless agreement is
required, a `scrollHeight` on a stretched body just reports the frame's own
height back, and a transient measured mid-load sticks — which is a frame with a
screen of white space under a page that got shorter.

Everything the canvas adds is off until `ss:canvas` arrives, so the ordinary
single-frame preview is left completely alone — including having its gestures
swallowed. A reloaded document starts from that default again, which is why the
frame's `load` handler says it a second time.

## Performance

Four whole pages at once is the expensive thing about this feature, and every
one of these exists because it was measured. On a marketing page in the app, one
ordinary preview frame costs ~20% CPU and ~420MB; four full-length copies of it
came to 64% and 3.3GB before this work and 25% and 1.1GB after.

- **A frame nobody is working in holds still** (`ss:passive`): animations
  paused, transitions off, videos paused. Four copies of the same marketing
  animation running forever was most of the cost. The active frame stays live.
- **The in-frame observer watches `<head>` for stylesheets**, not the whole
  document for attributes — a class toggled by a scroll animation was scheduling
  a CSSOM walk and a forced layout, in every frame, continuously.
- **Frames outside the mount window are unmounted** (the active one never is),
  so working zoomed into one frame tears down the three you cannot see. Each is
  a full dev-server client with its own HMR socket.
- **The scaled layer is promoted only while the user is moving it**, so a zoom
  is a compositor transform rather than tens of millions of pixels rasterised
  again — and the hint is dropped 300ms after they stop.
- **Each stage is `contain: strict`**, so a page reflowing inside one frame does
  not invalidate layout across the canvas.
- Scroll reaches React only when it has moved far enough to change which frames
  are mounted, and a gesture forwarded out of a frame is coalesced to one scroll
  write per animation frame.

Everything the canvas adds to a preview page — unit rewriting, page-height
watching, gesture forwarding — is off until `ss:canvas` arrives, so the ordinary
single-frame preview costs exactly what it cost before this feature existed.

## Testing it

`src/lib/previewCanvas.test.ts` covers the geometry and zoom maths;
`src/components/preview/PreviewCanvas.test.tsx` covers frame lifecycle, page
heights, zoom input (including gestures that arrive faster than a render),
panning, re-centring and the editor binding.

The parts that only exist in a browser — pointer anchoring against real layout,
viewport-unit rewriting, and the injected script's own behaviour — were verified
by mounting the real component over pages served through the same injection the
proxy performs, and driving it: whole pages come back at their real lengths with
their heroes still one screen tall, twelve pinch events inside one frame compound
to the zoom they should and hold their point to under a pixel on both axes, and
every pane size from 368px to 1188px lands with all four frames on screen.
