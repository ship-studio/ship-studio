# Breakpoint canvas

Every breakpoint at once, side by side, instead of one resizable preview frame.
Toggle it from the preview toolbar (the grid button at the end of the viewport
controls) or with Cmd+K → "Show every breakpoint".

Each frame is a real dev-server page. There is no second rendering path: an edit
goes to source and reaches every frame through the dev server's own HMR.

## The two constraints everything else follows from

**A frame's height is the viewport the page sees.** An iframe cannot report one
height and lay out at another, so a frame tall enough to show a whole page makes
`100vh` equal that whole page — the hero stops being one screen tall and every
viewport-relative unit in the page becomes a lie. Frames are therefore device
sized (`DEVICE_HEIGHTS` in [src/lib/previewCanvas.ts](../src/lib/previewCanvas.ts)),
and seeing the rest of the page means scrolling — which is why the frames scroll
together.

**A frame is a cross-origin document.** Wheel and gesture events that land on
one are delivered to it, and this window never sees them. The injected preview
script forwards the ones that belong to the canvas (zoom gestures) back up with
the point they happened at, and leaves the rest alone: scrolling a preview page
is scrolling a page.

## Parts

| Where | What it owns |
|---|---|
| [src/lib/previewCanvas.ts](../src/lib/previewCanvas.ts) | Geometry and zoom maths, no DOM: layout, fit scale, device heights, the mount window, pointer anchoring, zoom stepping |
| [src/components/preview/PreviewCanvas.tsx](../src/components/preview/PreviewCanvas.tsx) | The surface: two layers, frame lifecycle, the zoom control |
| [src/hooks/useCanvasZoom.ts](../src/hooks/useCanvasZoom.ts) | Every way to zoom, and the anchoring correction |
| [src/hooks/useCanvasPan.ts](../src/hooks/useCanvasPan.ts) | Space-drag and middle-drag |
| [src/hooks/useFrameScrollSync.ts](../src/hooks/useFrameScrollSync.ts) | Keeping the frames at the same point in the page |
| [src/hooks/usePreviewEditorFrame.ts](../src/hooks/usePreviewEditorFrame.ts) | What the editor, the inspector and screenshots point at |
| [src-tauri/src/proxy/select_script.html](../src-tauri/src/proxy/select_script.html) | The in-frame half: gesture forwarding, scroll reporting, `ss:selectAt` |

### Two layers, deliberately

The **scaled layer** holds the pages at their true CSS widths — the canvas is
only visually transformed, so media queries fire at the labelled width. The
**overlay layer** is unscaled and holds labels, frame outlines and the
structural-edit toolbar, so they stay legible and crisp at 25%.

Anything host-side positioned from a frame's own coordinates has to come through
the canvas scale, and past the label row: the frames start below it, and it is
not scaled. Leaving the label out of the anchor origin drifts a zoom vertically
by exactly `labelHeight × (1 − newScale / oldScale)`.

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

Host → frame: `ss:scrollTo {fraction}`, plus the editor's existing `ss:*`
protocol and `ss:selectAt {x, y}`.

Frame → host: `ss:scroll {top, fraction}`, `ss:wheelZoom {deltaY, x, y}`,
`ss:zoomBy {factor, x, y}` (WebKit pinch), and the editor's existing replies.

Scroll position travels as a **fraction** of each page's scrollable range,
because the same page is a different length at every width. A driven frame
reports back the position it was just sent, so the canvas recognises its own
echo and drops it; the frame side also holds off reporting for a moment after
being driven. The in-frame throttle is on the clock rather than on animation
frames: a frame that stops being painted never runs a rAF callback, and a
rAF-latched guard would kill that frame's sync permanently.

## Performance

Every mounted frame is a full dev-server client with its own HMR socket, so
frames more than a screen outside the visible canvas are unmounted (the active
one never is). Scroll only reaches React when it has moved far enough to change
which frames are mounted.

## Testing it

`src/lib/previewCanvas.test.ts` covers the geometry and zoom maths;
`src/components/preview/PreviewCanvas.test.tsx` covers frame lifecycle, zoom
input, panning, scroll sync and the editor binding.

The parts that only exist in a browser — pointer anchoring against real layout,
and the injected script's own behaviour — were verified by serving the harness
page through the same injection the proxy performs and driving it: a zoom holds
its point to the pixel on both axes, a scroll reports out and a driven scroll
lands at the right fraction, ctrl+wheel and WebKit gestures forward with their
coordinates, plain wheels are left alone, and `ss:selectAt` picks the element
under the point.
