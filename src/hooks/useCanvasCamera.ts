/**
 * The breakpoint canvas's camera — where the canvas is looking, and the only
 * thing a gesture is allowed to move.
 *
 * ## Why this exists
 *
 * The canvas used to be a native scroll container: position was `scrollLeft` /
 * `scrollTop`, and the zoom level was React state. That is the ordinary way to
 * build a scrollable pane and it is the wrong way to build a canvas, because
 * *every event of a gesture went through a render*. A pinch delivers events far
 * faster than a page can paint, and each one rewrote layout-affecting inline
 * styles — the surface's `width`/`height`, and every frame's `left`/`top`/
 * `width`/`height` in the overlay — and then wrote `scrollLeft`, which forces
 * layout synchronously. On a surface holding four live cross-origin pages that
 * is a full layout per event. It is the reason the canvas felt like treacle
 * next to a real design tool.
 *
 * A design tool does not do that. During a gesture it moves ONE composited
 * transform and touches nothing else; layout happens once, when the gesture is
 * over. That is all this hook is:
 *
 * - The live camera (`x`, `y`, `scale`) lives in a **ref**, never in state, so
 *   an event can move it without a render.
 * - Events accumulate; **one rAF** writes the transforms. Sixty events between
 *   two frames cost two style writes, not sixty layouts.
 * - React is told **once the gesture settles**. That is when the zoom readout
 *   becomes exact, the mount window is recomputed, and the overlay is laid out
 *   crisp again.
 *
 * ## The coordinate system is the old one
 *
 * `x` and `y` mean exactly what `scrollLeft` and `scrollTop` meant: the
 * screen-space offset of the surface under the visible box, with the frames
 * starting `slackX` / `slackY` into it. Every piece of geometry in
 * `lib/previewCanvas.ts` — resting position, pointer anchoring, the mount
 * window — is therefore unchanged and still describes this camera. A canvas
 * point `cx` is on screen at `slackX + cx * scale - x`, which is precisely the
 * world transform written below.
 *
 * ## What each gesture frame costs
 *
 * - **Pan:** one `translate3d` on the world. Nothing else moves, so nothing
 *   relayouts, and the frames' rasters are reused.
 * - **Zoom:** that translate, one `scale()` on the layer holding the pages, and
 *   one `scale()` on the overlay so labels and outlines track the pages instead
 *   of sliding off them. The overlay is laid out at the *committed* scale and
 *   corrected by the ratio while the gesture runs, so it is exactly right at
 *   rest and approximately right — rather than absent — mid-pinch.
 *
 * @module hooks/useCanvasCamera
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CANVAS_LABEL_PX, CANVAS_PADDING_PX, anchorScroll } from '../lib/previewCanvas';

/** How long after the last gesture event the canvas is considered still. Long
 *  enough to bridge the gap between two flicks of a trackpad (and the momentum
 *  phase macOS delivers after the fingers lift), short enough that the crisp
 *  re-layout follows the gesture rather than trailing it. */
const SETTLE_MS = 140;

/** How far the camera may travel before the mount window is recomputed
 *  mid-gesture, as a fraction of the visible box. Recomputing costs a render —
 *  the one thing a gesture is trying to avoid — but a pan that outruns the
 *  mount margin entirely would leave placeholders on screen, which is worse. */
const MOUNT_REFRESH_RATIO = 0.25;

export interface CameraPosition {
  x: number;
  y: number;
  scale: number;
}

/** Everything needed to know how far the camera may go. Canvas pixels for the
 *  content, screen pixels for the box and the slack. */
export interface CameraBounds {
  slackX: number;
  slackY: number;
  contentWidth: number;
  tallestHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface CanvasCameraControls {
  /** The live camera — the one a gesture has been moving, not the one React
   *  last rendered. */
  read: () => CameraPosition;
  /** Move by a screen-space delta, the way a wheel or a drag does. */
  panBy: (dx: number, dy: number) => void;
  /** Zoom, keeping the canvas point under (pointerX, pointerY) under it.
   *  Pointer coordinates are relative to the visible canvas box. */
  zoomAt: (nextScale: number, pointerX: number, pointerY: number) => void;
  /** Put the camera exactly here. Used by everything that decides a position
   *  rather than gesturing one: fit, re-centre, zoom-to-frame, a pane resize. */
  place: (next: Partial<CameraPosition>) => void;
  /** Tell React now rather than at the end of a gesture — for a placement that
   *  did not come from one. */
  commit: () => void;
}

/** What the hook hands back: the camera itself, whether it is moving, and the
 *  ref callbacks for the elements it writes to. The setters are returned flat
 *  rather than bundled, because they are used in JSX and reading them off an
 *  object the camera also lives in would be reading the camera during render. */
export interface CanvasCameraApi {
  controls: CanvasCameraControls;
  /** The camera is being moved right now (plus the settle tail). */
  interacting: boolean;
  /** The moved layer: everything on the canvas, carried by one translate. */
  setWorldEl: (node: HTMLDivElement | null) => void;
  /** The layer holding the pages, which carries the scale. */
  setScaledEl: (node: HTMLDivElement | null) => void;
  /** Labels and outlines, laid out at the committed scale and corrected by the
   *  ratio while a zoom is in flight. */
  setOverlayEl: (node: HTMLDivElement | null) => void;
  /** The zoom readout, kept truthful during a gesture without a render. */
  setReadoutEl: (node: HTMLElement | null) => void;
}

interface UseCanvasCameraParams {
  /** The scale React has rendered the overlay at. The camera corrects the
   *  overlay by the ratio between this and the live scale while a zoom runs. */
  committedScale: number;
  /** Recomputed on every render — a gesture reads the current one. */
  bounds: CameraBounds;
  /** The gesture is over (or has travelled far enough): here is where the
   *  camera ended up, laid out crisp from this. `scaleChanged` says whether a
   *  gesture actually zoomed — a pan must not publish a zoom level, or a long
   *  drag would quietly turn Fit into a fixed one. */
  onSettle: (camera: CameraPosition, meta: { scaleChanged: boolean }) => void;
}

/** Hold a camera inside the canvas's own extents. The reachable range is the
 *  scaled content plus the pan slack on each side, which is the same range the
 *  scroll container used to enforce for free. */
export function clampCamera(position: CameraPosition, bounds: CameraBounds): CameraPosition {
  const { slackX, slackY, contentWidth, tallestHeight, viewportWidth, viewportHeight } = bounds;
  const surfaceWidth = contentWidth * position.scale + slackX * 2;
  const surfaceHeight =
    CANVAS_LABEL_PX + tallestHeight * position.scale + CANVAS_PADDING_PX + slackY * 2;
  return {
    ...position,
    x: Math.max(0, Math.min(Math.max(0, surfaceWidth - viewportWidth), position.x)),
    y: Math.max(0, Math.min(Math.max(0, surfaceHeight - viewportHeight), position.y)),
  };
}

export function useCanvasCamera({
  committedScale,
  bounds,
  onSettle,
}: UseCanvasCameraParams): CanvasCameraApi {
  const cameraRef = useRef<CameraPosition>({ x: 0, y: 0, scale: committedScale });
  const boundsRef = useRef(bounds);

  const settleRef = useRef(onSettle);
  useEffect(() => {
    settleRef.current = onSettle;
  }, [onSettle]);

  const worldRef = useRef<HTMLDivElement | null>(null);
  const scaledRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const readoutRef = useRef<HTMLElement | null>(null);

  // The scale React last RENDERED, which is not the same question as the scale
  // the overlay was laid out at: this one exists only to notice a change.
  const renderedScaleRef = useRef(committedScale);
  // The scale the overlay was laid out at. Everything in the overlay is
  // positioned in screen pixels from this number, so while a zoom is in flight
  // the layer is scaled by the ratio to keep it over the pages it annotates.
  const committedScaleRef = useRef(committedScale);
  // Where the mount window was last recomputed from, so panning only pays for a
  // render once it has actually gone somewhere.
  const committedXRef = useRef(0);

  // Whether a gesture has changed the scale since the owner was last told.
  // Cleared by a placement that names its own scale: a decision — Fit, the
  // readout, zoom-to-frame — supersedes a gesture whose settle has not fired
  // yet, and without this the pinch you interrupted publishes its zoom a beat
  // later and undoes the thing you just pressed.
  const zoomedRef = useRef(false);

  const frameRef = useRef<number | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const [interacting, setInteracting] = useState(false);

  /** Write the camera to the DOM. The whole point of the hook: three style
   *  writes and a text node, no layout, no render. */
  const paint = useCallback(() => {
    const { x, y, scale } = cameraRef.current;
    const { slackX, slackY } = boundsRef.current;
    const world = worldRef.current;
    if (world) {
      // `translate3d` rather than `translate`: the canvas is one enormous layer
      // and this is what keeps it on the compositor between gestures too.
      world.style.transform = `translate3d(${slackX - x}px, ${slackY + CANVAS_LABEL_PX - y}px, 0)`;
    }
    const scaled = scaledRef.current;
    if (scaled) scaled.style.transform = `scale(${scale})`;
    const overlay = overlayRef.current;
    if (overlay) {
      const committed = committedScaleRef.current;
      const ratio = committed > 0 ? scale / committed : 1;
      // Exactly 1 at rest, so the labels and the 1px outlines are laid out and
      // painted at their true size rather than being permanently scaled by a
      // number that happens to round to it.
      overlay.style.transform = ratio === 1 ? '' : `scale(${ratio})`;
    }
    const readout = readoutRef.current;
    if (readout) readout.textContent = `${Math.round(scale * 100)}%`;
  }, []);

  const schedulePaint = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      paint();
    });
  }, [paint]);

  const commit = useCallback(() => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    setInteracting(false);
    committedXRef.current = cameraRef.current.x;
    const scaleChanged = zoomedRef.current;
    zoomedRef.current = false;
    settleRef.current({ ...cameraRef.current }, { scaleChanged });
  }, []);

  /** A gesture happened: paint it, and start (or restart) the clock that ends
   *  the gesture. */
  const touch = useCallback(() => {
    setInteracting(true);
    schedulePaint();
    if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      setInteracting(false);
      committedXRef.current = cameraRef.current.x;
      const scaleChanged = zoomedRef.current;
      zoomedRef.current = false;
      settleRef.current({ ...cameraRef.current }, { scaleChanged });
    }, SETTLE_MS);
    // A pan long enough to leave the mount window behind cannot wait for the
    // end of the gesture: the frames it is heading towards have to be mounted
    // before they arrive on screen.
    const travelled = Math.abs(cameraRef.current.x - committedXRef.current);
    const width = boundsRef.current.viewportWidth;
    if (width > 0 && travelled >= width * MOUNT_REFRESH_RATIO) {
      committedXRef.current = cameraRef.current.x;
      // Position only: the gesture is still running, and its zoom is published
      // when it ends.
      settleRef.current({ ...cameraRef.current }, { scaleChanged: false });
    }
  }, [schedulePaint]);

  const panBy = useCallback(
    (dx: number, dy: number) => {
      const camera = cameraRef.current;
      cameraRef.current = clampCamera(
        { ...camera, x: camera.x + dx, y: camera.y + dy },
        boundsRef.current
      );
      touch();
    },
    [touch]
  );

  const zoomAt = useCallback(
    (nextScale: number, pointerX: number, pointerY: number) => {
      const camera = cameraRef.current;
      if (nextScale === camera.scale) return;
      const { slackX, slackY } = boundsRef.current;
      // The same anchoring the scroll container used, against the same origin —
      // the frames start below the unscaled label row, and leaving that row out
      // drifts the anchor by labelHeight × (1 − new/old) on every event.
      zoomedRef.current = true;
      const anchored = anchorScroll({
        scrollLeft: camera.x,
        scrollTop: camera.y,
        pointerX,
        pointerY,
        fromScale: camera.scale,
        toScale: nextScale,
        originX: slackX,
        originY: slackY + CANVAS_LABEL_PX,
      });
      cameraRef.current = clampCamera(
        { x: anchored.scrollLeft, y: anchored.scrollTop, scale: nextScale },
        boundsRef.current
      );
      touch();
    },
    [touch]
  );

  const place = useCallback(
    (next: Partial<CameraPosition>) => {
      if (next.scale !== undefined) {
        zoomedRef.current = false;
        if (settleTimerRef.current !== null) {
          clearTimeout(settleTimerRef.current);
          settleTimerRef.current = null;
        }
      }
      cameraRef.current = clampCamera({ ...cameraRef.current, ...next }, boundsRef.current);
      // Painted straight away rather than on the next frame: a placement is
      // usually a jump (Fit, zoom-to-frame, a pane resize), and a jump that
      // lands one frame late is a visible slide.
      paint();
    },
    [paint]
  );

  // The overlay's correction is only meaningful against the scale React has
  // actually rendered, and that arrives a commit after the gesture asked for
  // it. Applied before paint so the crisp overlay and the reset of its
  // correction land in the same frame — otherwise the moment a zoom settles is
  // a visible pop.
  //
  // A rendered scale the camera did not ask for is someone else's decision —
  // Fit recomputing on a pane resize, the readout jumping to 100% — and the
  // camera adopts it. This cannot fight a gesture in flight: a gesture does not
  // tell React anything until it settles, so while one is running this scale
  // does not change.
  // A LAYOUT effect, and declared before the placement rules that also run in
  // one: those rules move the camera against the scale that has just been
  // rendered, and `place` clamps against whatever scale the camera is holding.
  // Adopting the new scale second would clamp a correct position against the
  // extents of the old one — a zoom-to-frame silently landing short.
  //
  // No dependency array: the extents move with the pane and the page heights
  // too, and a gesture reads them from a ref rather than from a render, so they
  // are refreshed on every commit and the layer is repainted from whatever the
  // camera currently holds.
  useLayoutEffect(() => {
    boundsRef.current = bounds;
    committedScaleRef.current = committedScale;
    // Adopted only when the RENDERED scale actually changed — never merely
    // because it differs from the live one. Mid-gesture they always differ: the
    // camera has moved and React has not been told yet, and the first event of
    // a gesture causes a render of its own (the canvas marks itself as being
    // moved). Adopting on every render would rewind each gesture to the value
    // on screen, and the rest of it would go nowhere.
    if (renderedScaleRef.current !== committedScale) {
      renderedScaleRef.current = committedScale;
      if (cameraRef.current.scale !== committedScale) {
        cameraRef.current = clampCamera(
          { ...cameraRef.current, scale: committedScale },
          boundsRef.current
        );
      }
    }
    paint();
  });

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    },
    []
  );

  const read = useCallback(() => ({ ...cameraRef.current }), []);

  // One stable object for the whole life of the canvas. Every rule that moves
  // the camera does so from a layout effect, and an identity that changed on
  // each render would re-run all of them — including the one that reads the
  // laid-out boxes, which forces layout — for nothing. `interacting` is handed
  // back beside it rather than inside it for exactly the same reason: it flips
  // twice per gesture, and only one rule cares.
  const controls = useMemo(
    () => ({ read, panBy, zoomAt, place, commit }),
    [read, panBy, zoomAt, place, commit]
  );

  // Plain ref callbacks. The element is stored and the layer painted at once,
  // so a canvas that mounts already placed does not show one frame at the
  // origin first.
  const setWorldEl = useCallback(
    (node: HTMLDivElement | null) => {
      worldRef.current = node;
      if (node) paint();
    },
    [paint]
  );
  const setScaledEl = useCallback(
    (node: HTMLDivElement | null) => {
      scaledRef.current = node;
      if (node) paint();
    },
    [paint]
  );
  const setOverlayEl = useCallback(
    (node: HTMLDivElement | null) => {
      overlayRef.current = node;
      if (node) paint();
    },
    [paint]
  );
  const setReadoutEl = useCallback((node: HTMLElement | null) => {
    readoutRef.current = node;
  }, []);

  return { controls, interacting, setWorldEl, setScaledEl, setOverlayEl, setReadoutEl };
}
