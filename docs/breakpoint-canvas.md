# Breakpoint canvas

Every breakpoint at once, side by side, instead of one resizable preview frame.
Toggle it from the preview toolbar (the grid button at the end of the viewport
controls) or with Cmd+K → "Show every breakpoint".

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

Two limits, both rare and both visible rather than silent:

- **Height-based media queries** still evaluate against the real (tall) frame.
- **`position: fixed`** pins to the whole page, so a fixed bar appears once
  instead of following the scroll — the same trade a full-page screenshot makes.

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
| [src/components/preview/PreviewCanvas.tsx](../src/components/preview/PreviewCanvas.tsx) | The surface: two layers, frame lifecycle, page heights, the zoom control |
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
viewport height to resolve your units against — plus the editor's existing `ss:*`
protocol and `ss:selectAt {x, y}`.

Frame → host: `ss:pageHeight {height}`, `ss:panBy {dx, dy}`, `ss:wheelZoom
{deltaY, x, y}`, `ss:zoomBy {factor, x, y}` (WebKit pinch), and the editor's
existing replies.

Everything the canvas adds is off until `ss:canvas` arrives, so the ordinary
single-frame preview is left completely alone — including having its gestures
swallowed. A reloaded document starts from that default again, which is why the
frame's `load` handler says it a second time.

## Performance

Every mounted frame is a full dev-server client with its own HMR socket, so
frames more than a screen outside the visible canvas are unmounted (the active
one never is). Scroll only reaches React when it has moved far enough to change
which frames are mounted.

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
