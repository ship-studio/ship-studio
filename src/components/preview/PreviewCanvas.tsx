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
import { useCanvasZoom } from '../../hooks/useCanvasZoom';
import { useCanvasPan } from '../../hooks/useCanvasPan';
import { Button } from '../primitives/Button';
import { kbd } from '../../lib/shortcuts';

/**
 * Tell a frame it is part of a canvas, and what viewport height it is standing
 * in for. The injected preview script keeps its gesture forwarding off until it
 * hears this, so the single preview frame's own gestures are left completely
 * alone — and the height is what lets the frame show the WHOLE page while
 * `100vh` still means one screen. A reloaded document starts from the default
 * again, hence the `load` handler.
 */
const announceCanvas = (frame: HTMLIFrameElement, on = true): void => {
  try {
    const viewportHeight = Number(frame.dataset.viewportHeight) || undefined;
    frame.contentWindow?.postMessage({ type: 'ss:canvas', on, vh: viewportHeight }, '*');
  } catch {
    // A frame mid-navigation can refuse; its load handler will say it again.
  }
};

/** A page longer than this is a runaway (an infinite scroller, a feedback loop
 *  between the frame's height and the page's own layout), not a page. */
const MAX_PAGE_HEIGHT_PX = 24000;

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
  const frameElsRef = useRef(new Map<string, HTMLIFrameElement | null>());

  // Visible canvas box (screen pixels) and scroll offset, both driving which
  // frames stay mounted and how large the fit scale is.
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scrollLeft, setScrollLeft] = useState(0);

  // What each page turned out to be, once it had been laid out at that width.
  // The device height is only the starting guess and the floor: the canvas
  // shows whole pages, so a frame is as tall as the document inside it.
  const [pageHeights, setPageHeights] = useState<Record<string, number>>({});
  const sizedFrames = useMemo(
    () =>
      frames.map((frame) => ({
        ...frame,
        height: Math.min(MAX_PAGE_HEIGHT_PX, Math.max(frame.height, pageHeights[frame.id] ?? 0)),
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
  const scale = zoom === 'fit' ? fitted : zoom;
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

  // Where the canvas sits when it has nothing better to do: the frames centred
  // in the pane, with the slack spread evenly around them.
  const contentWidthPx = layout.contentWidth * scale;
  const contentHeightPx = CANVAS_LABEL_PX + tallestFrameHeight * scale;
  const restingScroll = useCallback(
    () => ({
      left: Math.max(0, slackX - Math.max(0, (viewport.width - contentWidthPx) / 2)),
      top: Math.max(0, slackY - Math.max(0, (viewport.height - contentHeightPx) / 2)),
    }),
    [slackX, slackY, viewport.width, viewport.height, contentWidthPx, contentHeightPx]
  );

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

  // Whether the position on screen is the user's doing. Until it is, the canvas
  // keeps re-centring itself on every measurement.
  const userMovedRef = useRef(false);
  const parkScrollNow = useCallback((node: HTMLDivElement, left: number, top: number) => {
    node.scrollLeft = left;
    node.scrollTop = top;
  }, []);
  const markUserMoved = useCallback(() => {
    userMovedRef.current = true;
  }, []);

  // Measured from the ROOT, never from the scroller. The scroller contains the
  // surface, and the surface is sized from this measurement — so anything that
  // stops the scroller clipping (a scrollbar library relocating its children,
  // say) turns that into a feedback loop that runs the canvas off to millions
  // of pixels and leaves the user looking at grey. The root has one job and
  // holds nothing, so it cannot grow.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const measure = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    // Clamped to the window, which is the last word on how big a pane inside it
    // can be. The canvas sizes its surface from this number and then lives
    // inside the box it just sized, so any ancestor that fails to clip turns
    // the pair into a feedback loop — one that ends at several million pixels
    // and a user looking at grey. The clamp makes that arithmetically
    // impossible, whatever a stylesheet upstream decides to do.
    const width = Math.min(root.clientWidth, window.innerWidth || root.clientWidth);
    const height = Math.min(root.clientHeight, window.innerHeight || root.clientHeight);
    setViewport((current) =>
      current.width === width && current.height === height ? current : { width, height }
    );
  }, []);

  const setRootEl = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;
      if (node) measure();
    },
    [measure]
  );

  const setScrollEl = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
  }, []);

  // Ownership is taken by INPUT, never by a `scroll` event. The browser fires
  // those for its own reasons — including adjusting the offset when the content
  // grows, which is exactly what happens as the frames learn how long their
  // pages are. Reading that as "the user has placed the canvas" freezes it
  // wherever the growth left it, which on a first open is nowhere useful.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.addEventListener('wheel', markUserMoved, { passive: true });
    return () => node.removeEventListener('wheel', markUserMoved);
  }, [markUserMoved]);

  // Two sources, because the first one can lie. A pane measured during the
  // commit that mounts it has not necessarily reached its final size, and the
  // canvas that gets built from that measurement is the one the user opens.
  // The window's own resize is a second chance at the truth for webviews that
  // deliver it before the observer.
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure());
    observer?.observe(node);
    window.addEventListener('resize', measure);
    // One more read after the frame the canvas mounted in, for the case where
    // the pane was still settling when the ref callback measured it.
    const settle = requestAnimationFrame(measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      cancelAnimationFrame(settle);
    };
  }, [measure]);

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

  // Everything a frame reports back: how tall its page turned out to be, and
  // any gesture the frame could not use itself. A wheel over a frame showing a
  // whole page has nothing left to scroll there, so the frame hands it up and
  // it pans the canvas — which is what the gesture meant.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: string;
        height?: number;
        dx?: number;
        dy?: number;
      } | null;
      if (data?.type !== 'ss:pageHeight' && data?.type !== 'ss:panBy') return;
      let frameId: string | null = null;
      for (const [id, element] of frameElsRef.current.entries()) {
        if (element && element.contentWindow === event.source) frameId = id;
      }
      if (frameId === null) return; // not one of ours
      if (data.type === 'ss:pageHeight') {
        const height = Math.round(data.height ?? 0);
        if (height <= 0) return;
        setPageHeights((current) =>
          current[frameId] === height ? current : { ...current, [frameId]: height }
        );
        return;
      }
      const node = scrollRef.current;
      if (!node) return;
      userMovedRef.current = true;
      node.scrollLeft += data.dx ?? 0;
      node.scrollTop += data.dy ?? 0;
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // ONE stable ref callback for every frame — a per-frame closure would be a
  // new function on each render, and React would detach and re-attach a live
  // iframe (unbinding and rebinding the editor) for no reason. The frame it
  // belongs to comes off the element's own `data-frame-id`, and the cleanup
  // return (React 19) is what tells us a frame went away. Registration bumps
  // an epoch; the effect below turns that into one report of the active
  // element.
  const [frameEpoch, setFrameEpoch] = useState(0);
  const registerFrame = useCallback((element: HTMLIFrameElement) => {
    const frameId = element.dataset.frameId;
    if (!frameId) return;
    frameElsRef.current.set(frameId, element);
    announceCanvas(element);
    setFrameEpoch((epoch) => epoch + 1);
    return () => {
      // Best effort: a frame going away because the canvas is closing should
      // stop forwarding gestures and reporting scroll. A frame going away
      // because it unmounted doesn't care.
      announceCanvas(element, false);
      frameElsRef.current.delete(frameId);
      setFrameEpoch((epoch) => epoch + 1);
    };
  }, []);

  // Report the active frame's element upward whenever the binding could have
  // changed — a different frame, a remount, or the canvas going away.
  useEffect(() => {
    onActiveFrameElement(frameElsRef.current.get(activeFrameId) ?? null);
  }, [activeFrameId, frameEpoch, onActiveFrameElement]);
  useEffect(() => () => onActiveFrameElement(null), [onActiveFrameElement]);

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
    node.scrollLeft = rest.left;
    node.scrollTop = rest.top;
    setScrollLeft(node.scrollLeft);
    // `scale` is a dependency because a fit request usually changes it, and the
    // resting position has to be measured against the layout that produces.
  }, [recenterTick, scale, restingScroll]);

  const fitCanvas = useCallback(() => {
    // Fit hands the canvas back to the canvas: it is centred again, and it
    // stays centred through anything that resizes the pane afterwards.
    userMovedRef.current = false;
    onZoomChange('fit');
    requestRecenter();
  }, [onZoomChange, requestRecenter]);

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

  // Until the user moves the canvas themselves, it is simply centred — every
  // time, on every measurement. This is the difference between a canvas that
  // opens on the frames and one that opens on grey: the pane's FIRST measured
  // size cannot be trusted (a webview commits the mount before the pane has
  // settled), and a canvas that treats the opening position as a one-off is
  // stranded in the slack for good when that first number is wrong. Re-centring
  // is idempotent, so being told the size three times costs nothing.
  //
  // The moment the user pans, zooms or scrolls, the position is theirs: from
  // then on a resize compensates by the slack delta instead, which keeps what
  // they were looking at where it was.
  const appliedSlackRef = useRef<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || viewport.width <= 0) return;
    const applied = appliedSlackRef.current;
    if (userMovedRef.current && applied && applied.x === slackX && applied.y === slackY) return;
    appliedSlackRef.current = { x: slackX, y: slackY };
    if (!userMovedRef.current) {
      const rest = restingScroll();
      parkScrollNow(node, rest.left, rest.top);
    } else if (applied) {
      parkScrollNow(
        node,
        node.scrollLeft + slackX - applied.x,
        node.scrollTop + slackY - applied.y
      );
    }
    setScrollLeft(node.scrollLeft);
  }, [slackX, slackY, viewport.width, restingScroll, parkScrollNow]);

  // A canvas you cannot lose. Whatever the arithmetic did — a bad measurement,
  // a zoom that ran out of scroll range, a resize mid-gesture — if not one
  // frame overlaps the visible box, the canvas is showing nothing at all, and
  // no user has ever wanted that. Measured from the DOM rather than from the
  // numbers that produced it, so a wrong number can't also decide it was fine.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || viewport.width <= 0) return;
    const box = node.getBoundingClientRect();
    // Nothing measurable to reason about — a pane that hasn't been laid out, or
    // an environment that doesn't do layout at all. Silence is not evidence
    // that the canvas is lost.
    if (box.width <= 0 || box.height <= 0) return;
    const chrome = node.querySelectorAll('.preview-canvas-chrome');
    if (chrome.length === 0) return;
    let measurable = false;
    for (const element of chrome) {
      const frame = element.getBoundingClientRect();
      if (frame.width > 0 && frame.height > 0) measurable = true;
    }
    if (!measurable) return;
    for (const element of chrome) {
      const frame = element.getBoundingClientRect();
      const overlapX = Math.min(frame.right, box.right) - Math.max(frame.left, box.left);
      const overlapY = Math.min(frame.bottom, box.bottom) - Math.max(frame.top, box.top);
      if (overlapX > 0 && overlapY > 0) return;
    }
    // No state update: the scroll this causes reports itself like any other,
    // and publishing from here would be a set inside an effect with no
    // dependencies — one bad measurement away from a loop.
    const rest = restingScroll();
    parkScrollNow(node, rest.left, rest.top);
    // Deliberately every commit: this is the check that the arithmetic above it
    // produced something a person can see, and it can only be answered by
    // measuring what was actually laid out. It settles immediately — once a
    // frame overlaps the box it returns before touching anything.
  });

  return (
    <div
      ref={setRootEl}
      className={`preview-canvas-root${spaceHeld ? ' is-pannable' : ''}${
        panning ? ' is-panning' : ''
      }`}
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
                    onLoad={(event) => announceCanvas(event.currentTarget)}
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
                      title={`Work at ${placement.label} — ${placement.width} × ${placement.height}`}
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
