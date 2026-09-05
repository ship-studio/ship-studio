/**
 * Breakpoint canvas — every responsive breakpoint rendered at once, side by
 * side, on one scaled and scrollable surface.
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
  CANVAS_PADDING_PX,
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
import { useCanvasZoom } from '../../hooks/useCanvasZoom';
import { useCanvasPan } from '../../hooks/useCanvasPan';
import { useCanvasPlacement } from '../../hooks/useCanvasPlacement';
import { Button } from '../primitives/Button';
import { kbd } from '../../lib/shortcuts';

/** How far the canvas must scroll before the mount window is recomputed. The
 *  window carries a screen of slack on each side, so nothing can scroll into
 *  view within this distance. */
const SCROLL_RENDER_THRESHOLD_PX = 120;

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
   *  Rendered in the unscaled overlay at the frame's screen position, and given
   *  the scale so it can map the frame's own coordinates into screen space. */
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
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // The visible canvas box, and the scroll offset — together they decide the
  // fit scale, where the canvas rests, and which frames stay mounted.
  const { setRootEl, viewport } = useCanvasViewport();
  const [scrollLeft, setScrollLeft] = useState(0);

  const setScrollEl = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
  }, []);

  // The frames have to be wired up before the canvas knows how big they make it
  // — a frame reports its page height, which decides the geometry, which is
  // what placement is computed from. So the one thing a forwarded gesture needs
  // from placement is handed over afterwards, through this.
  const markMovedRef = useRef<() => void>(() => {});

  // Scroll drives the mount window, and nothing else — so it only has to reach
  // React when it has moved far enough to change which frames are mounted.
  // rAF-throttled on top of that, so a flung scrollbar can't queue a render per
  // frame while four live pages are already asking for the main thread.
  const scrollRafRef = useRef<number | null>(null);
  const handleScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const next = scrollRef.current?.scrollLeft ?? 0;
      setScrollLeft((previous) =>
        Math.abs(next - previous) >= SCROLL_RENDER_THRESHOLD_PX ? next : previous
      );
    });
  }, []);
  useEffect(
    () => () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    },
    []
  );

  // A gesture a frame could not use: it pans the canvas instead. Coalesced,
  // because a trackpad delivers these faster than the canvas can paint and each
  // one written straight to `scrollLeft` is its own scroll and its own repaint
  // of everything on the surface.
  const panPendingRef = useRef({ dx: 0, dy: 0 });
  const panRafRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (panRafRef.current !== null) cancelAnimationFrame(panRafRef.current);
    },
    []
  );
  const panBy = useCallback((dx: number, dy: number) => {
    markMovedRef.current();
    panPendingRef.current.dx += dx;
    panPendingRef.current.dy += dy;
    if (panRafRef.current !== null) return;
    panRafRef.current = requestAnimationFrame(() => {
      panRafRef.current = null;
      const scroller = scrollRef.current;
      if (!scroller) return;
      scroller.scrollLeft += panPendingRef.current.dx;
      scroller.scrollTop += panPendingRef.current.dy;
      panPendingRef.current = { dx: 0, dy: 0 };
    });
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

  const isFit = zoom === 'fit';
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
  const surfaceWidth = layout.contentWidth * scale + slackX * 2;
  const surfaceHeight =
    CANVAS_LABEL_PX + tallestFrameHeight * scale + CANVAS_PADDING_PX + slackY * 2;

  // The frames' on-screen extent, which is what "centred" is measured against.
  const contentWidthPx = layout.contentWidth * scale;
  const contentHeightPx = CANVAS_LABEL_PX + tallestFrameHeight * scale;

  const { markUserMoved, releaseToCanvas, interacting, restingScroll, parkScrollNow } =
    useCanvasPlacement({
      scrollRef,
      viewport,
      slackX,
      slackY,
      contentWidthPx,
      contentHeightPx,
      isFit,
      geometryToken: layout,
      onScrollSettled: setScrollLeft,
    });
  useEffect(() => {
    markMovedRef.current = markUserMoved;
  }, [markUserMoved]);

  const mounted = useMemo(
    () => new Set(visibleFrameIds(layout, scale, scrollLeft, viewport.width, slackX)),
    [layout, scale, scrollLeft, viewport.width, slackX]
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
    const node = scrollRef.current;
    if (!node) return;
    recenterRef.current = false;
    const rest = restingScroll();
    parkScrollNow(node, rest.left, rest.top);
    setScrollLeft(node.scrollLeft);
    // `scale` is a dependency because a fit request usually changes it, and the
    // resting position has to be measured against the layout that produces.
  }, [recenterTick, scale, restingScroll, parkScrollNow]);

  const fitCanvas = useCallback(() => {
    // Fit hands the canvas back to the canvas: it is centred again, and it
    // stays centred through anything that resizes the pane afterwards.
    releaseToCanvas();
    onZoomChange('fit');
    requestRecenter();
  }, [releaseToCanvas, onZoomChange, requestRecenter]);

  const zoomToLevel = useCallback(
    (next: number) => {
      markUserMoved();
      onZoomChange(next);
    },
    [markUserMoved, onZoomChange]
  );

  const { zoomFromCentre, parkScroll, consumeAnchored } = useCanvasZoom({
    scrollRef,
    frameElsRef,
    scale,
    slackX,
    slackY,
    onZoomChange: zoomToLevel,
    onFit: fitCanvas,
    onScrollSettled: setScrollLeft,
  });

  /** Activate a frame and bring it up to a workable size, centred. At Fit a
   *  four-frame canvas sits near 30%, which is fine for comparing and useless
   *  for working — this is the way from one to the other. */
  const zoomToFrame = useCallback(
    (frameId: string) => {
      const node = scrollRef.current;
      const placement = layout.placements.find((frame) => frame.id === frameId);
      if (!node || !placement) return;
      markUserMoved();
      const nextScale = zoomForFrame(placement.width, node.clientWidth);
      const frameHeightPx = CANVAS_LABEL_PX + placement.height * nextScale;
      parkScroll({
        scrollLeft: Math.max(
          0,
          slackX + (placement.x + placement.width / 2) * nextScale - node.clientWidth / 2
        ),
        scrollTop: Math.max(0, slackY - Math.max(0, (node.clientHeight - frameHeightPx) / 2)),
      });
      onActivateFrame(frameId);
      onZoomChange(nextScale);
    },
    [layout, slackX, slackY, onActivateFrame, onZoomChange, parkScroll, markUserMoved]
  );

  const { spaceHeld, panning, handlePanStart } = useCanvasPan({
    scrollRef,
    onScrollSettled: setScrollLeft,
    onPan: markUserMoved,
  });

  // Leaving Fit for an explicit zoom level with no gesture behind it (the
  // readout, say) centres on the frame being worked in.
  const previousFitRef = useRef(zoom === 'fit');
  useEffect(() => {
    const isFit = zoom === 'fit';
    if (previousFitRef.current === isFit) return;
    previousFitRef.current = isFit;
    if (isFit) return;
    // A gesture that just anchored itself at the pointer owns the scroll
    // position — re-centring would throw away the place the user zoomed into.
    if (consumeAnchored()) return;
    const node = scrollRef.current;
    if (!node) return;
    node.scrollLeft = scrollToCenterFrame(layout, activeFrameId, zoom, node.clientWidth, slackX);
  }, [zoom, layout, activeFrameId, slackX, consumeAnchored]);

  return (
    <div
      ref={setRootEl}
      className={`preview-canvas-root${spaceHeld ? ' is-pannable' : ''}${
        panning ? ' is-panning' : ''
      }${interacting ? ' is-interacting' : ''}`}
    >
      <div
        className="preview-canvas"
        ref={setScrollEl}
        onScroll={handleScroll}
        onMouseDown={handlePanStart}
      >
        <div
          className="preview-canvas-surface"
          style={{ width: `${surfaceWidth}px`, height: `${surfaceHeight}px` }}
        >
          {/* Scaled layer: the real pages, laid out at their true CSS widths. */}
          <div
            className="preview-canvas-scaled"
            style={{
              width: `${layout.contentWidth}px`,
              height: `${tallestFrameHeight}px`,
              left: `${slackX}px`,
              top: `${slackY + CANVAS_LABEL_PX}px`,
              transform: `scale(${scale})`,
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
              Kept out of the transform so they stay legible and crisp at any zoom. */}
          <div className="preview-canvas-overlay">
            {layout.placements.map((placement) => {
              const isActive = placement.id === activeFrameId;
              return (
                <div
                  key={placement.id}
                  className={`preview-canvas-chrome${isActive ? ' is-active' : ''}`}
                  style={{
                    left: `${slackX + placement.x * scale}px`,
                    top: `${slackY}px`,
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
            Cmd+1 to spare for it. */}
        <Button
          size="compact"
          variant="ghost"
          className="preview-canvas-zoom-readout"
          onClick={() => zoomToLevel(1)}
          title="Zoom to 100%"
        >
          {Math.round(scale * 100)}%
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
