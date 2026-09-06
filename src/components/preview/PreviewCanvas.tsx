/**
 * Breakpoint canvas — every responsive breakpoint rendered at once, side by
 * side, on one scaled surface you can push around.
 *
 * Each frame is a real dev-server page laid out at its true CSS width (the
 * canvas is only visually scaled, so media queries fire at the labelled width),
 * which means a source edit reaches every frame through the dev server's own
 * HMR — there is no second rendering path to keep in sync.
 *
 * Exactly one frame is ACTIVE: it is interactive, it is the frame the visual
 * editor binds to, and it owns navigation. The others are inert review
 * surfaces behind a click-to-activate overlay, so a stray click in a 25%-scaled
 * frame can't fire a link or hand the editor an ambiguous target.
 *
 * Frames scrolled far outside the visible canvas are unmounted — each mounted
 * frame is a full dev-server client with its own HMR socket.
 *
 * ## The canvas does not scroll
 *
 * It used to, and that was the single biggest thing wrong with how it felt. A
 * native scroll container means position is `scrollLeft`, zoom is React state,
 * and therefore every event of a gesture is a render that rewrites
 * layout-affecting styles and then forces layout — on a surface holding four
 * live cross-origin pages.
 *
 * Instead there is a **camera** (`useCanvasCamera`) and one transformed layer.
 * A gesture moves the camera, the camera writes a transform, and React is told
 * once the gesture settles. Panning is a single composited `translate3d`;
 * nothing relayouts and the frames' rasters are reused. Two structural
 * consequences show up in the markup below:
 *
 * - The overlay (labels, outlines, activation targets) lives INSIDE the moved
 *   layer, so panning carries it along for free instead of re-rendering it.
 *   It is laid out in screen pixels at the committed scale and the camera
 *   corrects it by a ratio mid-zoom, which is why it goes crisp when a zoom
 *   settles rather than being re-laid-out on every event of one.
 * - There is no scroll container to clamp the position, so the camera clamps
 *   itself against the same extents the scrollbars used to describe.
 *
 * @module components/preview/PreviewCanvas
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  CANVAS_LABEL_PX,
  MAX_ZOOM,
  MIN_ZOOM,
  PAN_SLACK_RATIO,
  fitScale,
  layoutFrames,
  scrollToCenterFrame,
  tallestFrame,
  visibleFrameIds,
  zoomForFrame,
  type CanvasFrame,
} from '../../lib/previewCanvas';
import { useCanvasFrames } from '../../hooks/useCanvasFrames';
import { useCanvasViewport } from '../../hooks/useCanvasViewport';
import { useCanvasCamera, type CameraPosition } from '../../hooks/useCanvasCamera';
import { useCanvasGestures } from '../../hooks/useCanvasGestures';
import { useCanvasPan } from '../../hooks/useCanvasPan';
import { useCanvasPlacement } from '../../hooks/useCanvasPlacement';
import { useCanvasReveal } from '../../hooks/useCanvasReveal';
import { Button } from '../primitives/Button';
import { kbd } from '../../lib/shortcuts';

/** How far the camera must travel before the mount window is recomputed. The
 *  window carries a screen of slack on each side, so nothing can come into view
 *  within this distance. */
const MOUNT_WINDOW_THRESHOLD_PX = 120;

/** `'fit'` recomputes on every resize; a number is an explicit zoom level. */
export type CanvasZoom = 'fit' | number;

interface PreviewCanvasProps {
  /** Frames to render, widest first. */
  frames: CanvasFrame[];
  /** The page the canvas is showing. Passive frames follow it immediately —
   *  including when the ACTIVE frame client-side-navigates to somewhere new. */
  url: string;
  /** Changes only on a deliberate navigation (the page switcher, the locale
   *  switcher), never on the active frame navigating itself. That distinction is
   *  what keeps a link click inside the active frame from reloading the very
   *  frame that just navigated. */
  navSignal: string;
  /** The interactive/editable frame. */
  activeFrameId: string;
  /** Bumped by the preview's refresh action — remounts every frame. */
  reloadToken: number;
  zoom: CanvasZoom;
  onZoomChange: (zoom: CanvasZoom) => void;
  /** A frame was clicked: make it the active one. `point` is where the click
   *  landed inside that frame, in the frame's OWN css pixels — so the click can
   *  also select what the user was pointing at rather than being spent on
   *  activation alone. */
  onActivateFrame: (frameId: string, point?: { x: number; y: number }) => void;
  /** The active frame's element, or null while it isn't mounted. The visual
   *  editor binds to whatever this reports. */
  onActiveFrameElement: (element: HTMLIFrameElement | null) => void;
  /** The frame height the canvas settled on (unscaled canvas pixels), so host
   *  chrome can be clamped to the same box. */
  onStageHeightChange?: (height: number) => void;
  /** Host chrome drawn over the active frame — the structural-edit toolbar.
   *  Rendered in the overlay at the frame's screen position, and given the
   *  scale so it can map the frame's own coordinates into screen space. */
  activeFrameOverlay?: (scale: number) => ReactNode;
}

export function PreviewCanvas({
  frames,
  url,
  navSignal,
  activeFrameId,
  reloadToken,
  zoom,
  onZoomChange,
  onActivateFrame,
  onActiveFrameElement,
  onStageHeightChange,
  activeFrameOverlay,
}: PreviewCanvasProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // The visible canvas box, and where the camera has settled — together they
  // decide the fit scale, where the canvas rests, and which frames stay mounted.
  const { setRootEl, viewport } = useCanvasViewport();
  const [cameraX, setCameraX] = useState(0);

  const setRoot = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;
      setRootEl(node);
    },
    [setRootEl]
  );
  const setViewportEl = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node;
  }, []);

  // The frames have to be wired up before the canvas knows how big they make it
  // — a frame reports its page height, which decides the geometry, which is
  // what placement is computed from. So the one thing a forwarded gesture needs
  // from placement is handed over afterwards, through this.
  const markMovedRef = useRef<() => void>(() => {});

  const isFit = zoom === 'fit';

  // Everything below needs the layout, and the layout needs the frames, so the
  // frames are wired up first and the camera is given a callback that reads
  // them later.
  const cameraRef = useRef<{ panBy: (dx: number, dy: number) => void }>({ panBy: () => {} });
  const panBy = useCallback((dx: number, dy: number) => {
    markMovedRef.current();
    cameraRef.current.panBy(dx, dy);
  }, []);

  const { frameElsRef, registerFrame, handleFrameLoad, pageHeights } = useCanvasFrames({
    activeFrameId,
    onActiveFrameElement,
    onPanBy: panBy,
  });

  // What each page turned out to be, once it had been laid out at that width.
  // The device height is only the starting guess and the floor: the canvas
  // shows whole pages, so a frame is as tall as the document inside it.
  const sizedFrames = useMemo(
    () =>
      frames.map((frame) => ({
        ...frame,
        height: Math.max(frame.height, pageHeights[frame.id] ?? 0),
      })),
    [frames, pageHeights]
  );
  const layout = useMemo(() => layoutFrames(sizedFrames), [sizedFrames]);
  // The viewport height each frame stands in for — the device height, NOT the
  // height the frame ends up being. This is the number the page's `vh` units
  // are resolved against.
  const deviceHeights = useMemo(
    () => new Map(frames.map((frame) => [frame.id, frame.height])),
    [frames]
  );

  const fitted = fitScale(layout.contentWidth, viewport.width);
  const scale = isFit ? fitted : zoom;
  // Room around the frames so the canvas can be pushed past its own content —
  // screen-space, so it doesn't change what has to fit at Fit, and constant
  // across a zoom (which keeps pointer anchoring honest).
  const slackX = viewport.width * PAN_SLACK_RATIO;
  const slackY = viewport.height * PAN_SLACK_RATIO;
  // Every frame is a device: its own width AND its own height. A frame's height
  // is the viewport the page reports, so it cannot be derived from the pane or
  // the zoom — a `100vh` hero is exactly as tall as the frame says it is, and a
  // frame sized from the pane makes every viewport-relative unit in the page a
  // lie. The page scrolls inside its frame, like it does in a browser.
  const tallestFrameHeight = tallestFrame(layout);

  // The frames' on-screen extent, which is what "centred" is measured against.
  const contentWidthPx = layout.contentWidth * scale;
  const contentHeightPx = CANVAS_LABEL_PX + tallestFrameHeight * scale;

  const bounds = useMemo(
    () => ({
      slackX,
      slackY,
      contentWidth: layout.contentWidth,
      tallestHeight: tallestFrameHeight,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
    }),
    [slackX, slackY, layout.contentWidth, tallestFrameHeight, viewport.width, viewport.height]
  );

  // Where a gesture ends up. The mount window only has to be recomputed when
  // the camera has gone far enough to change it, and the zoom level is only
  // published when the gesture actually changed it — otherwise a long pan would
  // quietly turn Fit into a fixed zoom level.
  const handleSettle = useCallback(
    (camera: CameraPosition, { scaleChanged }: { scaleChanged: boolean }) => {
      setCameraX((previous) =>
        Math.abs(camera.x - previous) >= MOUNT_WINDOW_THRESHOLD_PX ? camera.x : previous
      );
      if (scaleChanged && camera.scale !== scale) onZoomChange(camera.scale);
    },
    [scale, onZoomChange]
  );

  const {
    controls: camera,
    interacting,
    setWorldEl,
    setScaledEl,
    setOverlayEl,
    setReadoutEl,
  } = useCanvasCamera({
    committedScale: scale,
    bounds,
    onSettle: handleSettle,
  });
  useEffect(() => {
    cameraRef.current = camera;
  }, [camera]);

  const { markUserMoved, releaseToCanvas, restingCamera } = useCanvasPlacement({
    camera,
    interacting,
    rootRef,
    viewport,
    slackX,
    slackY,
    contentWidthPx,
    contentHeightPx,
    isFit,
    scale,
    geometryToken: layout,
  });
  useEffect(() => {
    markMovedRef.current = markUserMoved;
  }, [markUserMoved]);

  // A frame must be mounted at some height before it can be measured, and the
  // only honest guess is the device's own. So the first measurement moves every
  // frame from one screen to a whole page at once, and the canvas re-centres
  // under them: correct, and indistinguishable from the feature glitching. The
  // canvas is held back until the frames know their heights, so it appears once,
  // already right.
  const unmeasured = layout.placements.filter((p) => !pageHeights[p.id]).length;
  const revealed = useCanvasReveal(unmeasured, reloadToken);

  const mounted = useMemo(
    () => new Set(visibleFrameIds(layout, scale, cameraX, viewport.width, slackX)),
    [layout, scale, cameraX, viewport.width, slackX]
  );
  // The active frame is never torn down — the editor is bound to it, and a
  // scroll that unmounted it would silently drop the binding.
  const isMounted = useCallback(
    (frameId: string) => frameId === activeFrameId || mounted.has(frameId),
    [mounted, activeFrameId]
  );

  // The active frame's own src. Passive frames track `url` directly; the active
  // frame is only re-pointed on a deliberate navigation, a refresh, or when the
  // user activates a different frame — otherwise following its own client-side
  // navigation back into its `src` would reload the page it just navigated to
  // and throw away the app state the user is looking at.
  const urlRef = useRef(url);
  useEffect(() => {
    urlRef.current = url;
  });
  const [activeSrc, setActiveSrc] = useState(url);
  useEffect(() => {
    setActiveSrc(urlRef.current);
  }, [navSignal, activeFrameId, reloadToken]);

  const activeFrameHeight =
    layout.placements.find((frame) => frame.id === activeFrameId)?.height ?? tallestFrameHeight;
  useEffect(() => {
    onStageHeightChange?.(activeFrameHeight);
  }, [activeFrameHeight, onStageHeightChange]);

  // Re-centring is a request, not a state: pressing Fit while already fitting
  // has to work, because "I can't see anything" is exactly when it gets
  // pressed. The tick makes the request; the ref makes sure it is honoured once
  // rather than on every later zoom.
  const recenterRef = useRef(false);
  const [recenterTick, setRecenterTick] = useState(0);
  const requestRecenter = useCallback(() => {
    recenterRef.current = true;
    setRecenterTick((tick) => tick + 1);
  }, []);
  useLayoutEffect(() => {
    if (!recenterRef.current) return;
    recenterRef.current = false;
    camera.place(restingCamera());
    camera.commit();
    // `scale` is a dependency because a fit request usually changes it, and the
    // resting position has to be measured against the layout that produces.
  }, [recenterTick, scale, restingCamera, camera]);

  const fitCanvas = useCallback(() => {
    // Fit hands the canvas back to the canvas: it is centred again, and it
    // stays centred through anything that resizes the pane afterwards. The
    // scale is placed as well as published, so a pinch that has not settled yet
    // cannot come back a beat later and undo it.
    releaseToCanvas();
    camera.place({ scale: fitted });
    onZoomChange('fit');
    requestRecenter();
  }, [releaseToCanvas, onZoomChange, requestRecenter, camera, fitted]);

  const { zoomFromCentre, consumeAnchored } = useCanvasGestures({
    viewportRef,
    camera,
    frameElsRef,
    onUserMoved: markUserMoved,
    onFit: fitCanvas,
  });

  const zoomToLevel = useCallback(
    (next: number) => {
      markUserMoved();
      camera.place({ scale: next });
      onZoomChange(next);
    },
    [markUserMoved, onZoomChange, camera]
  );

  /** Activate a frame and bring it up to a workable size, centred. At Fit a
   *  four-frame canvas sits near 30%, which is fine for comparing and useless
   *  for working — this is the way from one to the other. */
  const zoomToFrame = useCallback(
    (frameId: string) => {
      const placement = layout.placements.find((frame) => frame.id === frameId);
      if (!placement) return;
      markUserMoved();
      const nextScale = zoomForFrame(placement.width, viewport.width);
      const frameHeightPx = CANVAS_LABEL_PX + placement.height * nextScale;
      camera.place({
        scale: nextScale,
        x: Math.max(
          0,
          slackX + (placement.x + placement.width / 2) * nextScale - viewport.width / 2
        ),
        y: Math.max(0, slackY - Math.max(0, (viewport.height - frameHeightPx) / 2)),
      });
      onActivateFrame(frameId);
      onZoomChange(nextScale);
    },
    [
      layout,
      slackX,
      slackY,
      viewport.width,
      viewport.height,
      onActivateFrame,
      onZoomChange,
      camera,
      markUserMoved,
    ]
  );

  const { spaceHeld, panning, handlePanStart } = useCanvasPan({
    camera,
    onPan: markUserMoved,
  });

  // Leaving Fit for an explicit zoom level with no gesture behind it (the
  // readout, say) centres on the frame being worked in.
  const previousFitRef = useRef(zoom === 'fit');
  useEffect(() => {
    const nowFit = zoom === 'fit';
    if (previousFitRef.current === nowFit) return;
    previousFitRef.current = nowFit;
    if (nowFit) return;
    // A gesture that just anchored itself at the pointer owns the camera —
    // re-centring would throw away the place the user zoomed into.
    if (consumeAnchored()) return;
    camera.place({
      x: scrollToCenterFrame(layout, activeFrameId, zoom, viewport.width, slackX),
    });
    camera.commit();
  }, [zoom, layout, activeFrameId, slackX, viewport.width, consumeAnchored, camera]);

  return (
    <div
      ref={setRoot}
      className={`preview-canvas-root${spaceHeld ? ' is-pannable' : ''}${
        panning ? ' is-panning' : ''
      }${interacting ? ' is-interacting' : ''}${revealed ? '' : ' is-measuring'}`}
    >
      <div className="preview-canvas" ref={setViewportEl} onMouseDown={handlePanStart}>
        {/* The moved layer. Everything on the canvas is inside it, so a pan is
            one composited transform and nothing else on the page moves. */}
        <div className="preview-canvas-world" ref={setWorldEl}>
          {/* Scaled layer: the real pages, laid out at their true CSS widths. */}
          <div
            className="preview-canvas-scaled"
            ref={setScaledEl}
            style={{
              width: `${layout.contentWidth}px`,
              height: `${tallestFrameHeight}px`,
            }}
          >
            {layout.placements.map((placement) => (
              <div
                key={placement.id}
                className="preview-canvas-stage"
                style={{
                  left: `${placement.x}px`,
                  width: `${placement.width}px`,
                  height: `${placement.height}px`,
                }}
              >
                {isMounted(placement.id) ? (
                  <iframe
                    key={`${placement.id}:${reloadToken}`}
                    ref={registerFrame}
                    src={placement.id === activeFrameId ? activeSrc : url}
                    className="preview-canvas-iframe"
                    // A canvas frame shows its WHOLE page, so it never scrolls
                    // — and it must not be scroll-ABLE either. A frame opens at
                    // its device height, which the page overflows until it has
                    // been measured, and WebKit subtracts the scrollbar that
                    // appears from the width it evaluates media queries at: at
                    // 1024 the laptop drops below its own breakpoint, lays out
                    // taller, and the frame grows — which removes the scrollbar
                    // and puts it back. That two-state cycle is why one frame
                    // reported thousands of pixels more page than it had.
                    scrolling="no"
                    title={`${placement.label} preview`}
                    data-tooltip-disabled
                    data-frame-id={placement.id}
                    data-viewport-height={deviceHeights.get(placement.id) ?? placement.height}
                    onLoad={(event) => handleFrameLoad(event.currentTarget)}
                  />
                ) : (
                  <div className="preview-canvas-placeholder" aria-hidden />
                )}
              </div>
            ))}
          </div>

          {/* Unscaled layer: labels, frame outlines, and the activation targets.
              Laid out in screen pixels at the committed scale so they stay
              legible and crisp; the camera scales this layer by the ratio while
              a zoom is in flight, and back to exactly 1 when it settles. */}
          <div className="preview-canvas-overlay" ref={setOverlayEl}>
            {layout.placements.map((placement) => {
              const isActive = placement.id === activeFrameId;
              return (
                <div
                  key={placement.id}
                  className={`preview-canvas-chrome${isActive ? ' is-active' : ''}`}
                  style={{
                    left: `${placement.x * scale}px`,
                    top: `${-CANVAS_LABEL_PX}px`,
                    width: `${placement.width * scale}px`,
                    height: `${CANVAS_LABEL_PX + placement.height * scale}px`,
                  }}
                >
                  <button
                    type="button"
                    className="preview-canvas-label"
                    style={{ height: `${CANVAS_LABEL_PX}px` }}
                    onClick={() => zoomToFrame(placement.id)}
                    title={`${placement.label} — ${placement.width} × ${placement.height}. Click to work at this size.`}
                    aria-label={`Zoom to ${placement.label}`}
                  >
                    <span className="preview-canvas-label-name">{placement.label}</span>
                    <span className="preview-canvas-label-width">
                      {placement.width}
                      <span aria-hidden> × </span>
                      {placement.height}
                    </span>
                  </button>
                  {isActive ? (
                    <div className="preview-canvas-outline">{activeFrameOverlay?.(scale)}</div>
                  ) : (
                    <button
                      type="button"
                      className="preview-canvas-activate"
                      onClick={(event) => {
                        // Keyboard activation reports a zero point; only a real
                        // click carries a position worth selecting at.
                        const box = event.currentTarget.getBoundingClientRect();
                        const point =
                          event.detail > 0
                            ? {
                                x: (event.clientX - box.left) / scale,
                                y: (event.clientY - box.top) / scale,
                              }
                            : undefined;
                        onActivateFrame(placement.id, point);
                      }}
                      // No tooltip: this target is the whole frame, and a
                      // frame is taller than the pane — the tooltip would be
                      // placed against a box whose top edge is somewhere off
                      // the canvas, and land on the toolbar. The label above
                      // the frame already says what it is.
                      data-tooltip-disabled
                      aria-label={`Work at ${placement.label}, ${placement.width} pixels`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="preview-canvas-zoom" role="group" aria-label="Canvas zoom">
        <Button
          size="compact"
          variant="ghost"
          onClick={() => zoomFromCentre('out')}
          disabled={scale <= MIN_ZOOM}
          title={`Zoom out (${kbd('mod', '-')})`}
          aria-label="Zoom out"
        >
          &minus;
        </Button>
        {/* The readout doubles as the way back to true size — there is no
            Cmd+1 to spare for it. Its text is written by the camera during a
            gesture, so it keeps up with a pinch without a render. */}
        <Button
          size="compact"
          variant="ghost"
          className="preview-canvas-zoom-readout"
          onClick={() => zoomToLevel(1)}
          title="Zoom to 100%"
        >
          <span ref={setReadoutEl}>{Math.round(scale * 100)}%</span>
        </Button>
        <Button
          size="compact"
          variant="ghost"
          onClick={() => zoomFromCentre('in')}
          disabled={scale >= MAX_ZOOM}
          title={`Zoom in (${kbd('mod', '+')})`}
          aria-label="Zoom in"
        >
          +
        </Button>
        <Button
          size="compact"
          variant={zoom === 'fit' ? 'secondary' : 'ghost'}
          onClick={fitCanvas}
          aria-pressed={zoom === 'fit'}
          title={`Fit every breakpoint (${kbd('mod', '0')})`}
        >
          Fit
        </Button>
      </div>
    </div>
  );
}
