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
  anchorScroll,
  clampZoom,
  fitScale,
  layoutFrames,
  scrollToCenterFrame,
  stepZoom,
  tallestFrame,
  visibleFrameIds,
  wheelZoom,
  type CanvasFrame,
} from '../../lib/previewCanvas';
import { Button } from '../primitives/Button';
import { kbd } from '../../lib/shortcuts';

/** How close two scroll fractions have to be to count as the same position.
 *  At 0.0005 that is half a pixel on a 1000px scroll range. */
const SCROLL_ECHO_EPSILON = 0.0005;

/** How long a broadcast position stays recognisable as our own echo. */
const SCROLL_ECHO_WINDOW_MS = 500;

/** How far the canvas must scroll before the mount window is recomputed. The
 *  window carries a screen of slack on each side, so nothing can scroll into
 *  view within this distance. */
const SCROLL_RENDER_THRESHOLD_PX = 120;

/** WebKit's non-standard pinch events (Safari and every Tauri webview on
 *  macOS). Not in lib.dom, so the shape we use is spelled out here. */
interface GestureLikeEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

/** Keyboard shortcuts must not fire while the user is typing somewhere. */
const isTypingTarget = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  if (!element) return false;
  if (element.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName ?? '');
};

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

  const layout = useMemo(() => layoutFrames(frames), [frames]);

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
  const stageHeight = tallestFrame(layout);
  const surfaceWidth = layout.contentWidth * scale + slackX * 2;
  const surfaceHeight = CANVAS_LABEL_PX + stageHeight * scale + CANVAS_PADDING_PX + slackY * 2;

  // Where the canvas sits when it has nothing better to do: the frames centred
  // in the pane, with the slack spread evenly around them.
  const contentWidthPx = layout.contentWidth * scale;
  const contentHeightPx = CANVAS_LABEL_PX + stageHeight * scale;
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

  const setScrollEl = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    if (!node) return;
    setViewport({ width: node.clientWidth, height: node.clientHeight });
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      setViewport({ width: node.clientWidth, height: node.clientHeight });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

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
    setFrameEpoch((epoch) => epoch + 1);
    return () => {
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
    layout.placements.find((frame) => frame.id === activeFrameId)?.height ?? stageHeight;
  useEffect(() => {
    onStageHeightChange?.(activeFrameHeight);
  }, [activeFrameHeight, onStageHeightChange]);

  // ── Zoom at the pointer ────────────────────────────────────
  // A zoom change goes through state, so the scroll correction that keeps the
  // point under the cursor in place has to wait for the new layout: it is
  // parked here and applied in the layout effect below, before paint.
  const pendingAnchorRef = useRef<{ scrollLeft: number; scrollTop: number } | null>(null);
  // Set when an anchored zoom has just placed the scroll position, so the
  // fit-re-centring effect below (which runs later in the same commit) leaves
  // it alone instead of yanking the view to the active frame.
  const anchoredRef = useRef(false);
  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current;
    const node = scrollRef.current;
    if (!pending || !node) return;
    pendingAnchorRef.current = null;
    anchoredRef.current = true;
    node.scrollLeft = pending.scrollLeft;
    node.scrollTop = pending.scrollTop;
    setScrollLeft(node.scrollLeft);
  }, [scale]);

  const zoomAt = useCallback(
    (nextScale: number, pointerX: number, pointerY: number) => {
      const node = scrollRef.current;
      if (!node || nextScale === scale) return;
      pendingAnchorRef.current = anchorScroll({
        scrollLeft: node.scrollLeft,
        scrollTop: node.scrollTop,
        pointerX,
        pointerY,
        fromScale: scale,
        toScale: nextScale,
        originX: slackX,
        originY: slackY,
      });
      onZoomChange(nextScale);
    },
    [scale, onZoomChange, slackX, slackY]
  );

  /** Zoom about the middle of the canvas — for the buttons and the keyboard,
   *  which have no pointer to zoom around. */
  const zoomFromCentre = useCallback(
    (direction: 'in' | 'out') => {
      const node = scrollRef.current;
      zoomAt(
        stepZoom(scale, direction),
        (node?.clientWidth ?? 0) / 2,
        (node?.clientHeight ?? 0) / 2
      );
    },
    [scale, zoomAt]
  );

  // Ctrl/Cmd+wheel and trackpad pinch (which the browser also reports as a wheel
  // with ctrlKey). Registered by hand because it must be non-passive: without
  // preventDefault the gesture zooms the whole app window instead.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const box = node.getBoundingClientRect();
      zoomAt(wheelZoom(scale, event.deltaY), event.clientX - box.left, event.clientY - box.top);
    };
    node.addEventListener('wheel', onWheel, { passive: false });

    // WebKit reports a trackpad pinch as its own gesture events rather than as
    // ctrl+wheel, and the app runs on WebKit — without these, pinching over the
    // canvas does nothing at all on macOS.
    let gestureScale = 1;
    const onGestureStart = (event: GestureLikeEvent) => {
      event.preventDefault();
      gestureScale = event.scale || 1;
    };
    const onGestureChange = (event: GestureLikeEvent) => {
      event.preventDefault();
      const now = event.scale || 1;
      const factor = gestureScale > 0 ? now / gestureScale : 1;
      gestureScale = now;
      const box = node.getBoundingClientRect();
      zoomAt(clampZoom(scale * factor), event.clientX - box.left, event.clientY - box.top);
    };
    const onGestureEnd = (event: GestureLikeEvent) => {
      event.preventDefault();
      gestureScale = 1;
    };
    node.addEventListener('gesturestart', onGestureStart as EventListener, { passive: false });
    node.addEventListener('gesturechange', onGestureChange as EventListener, { passive: false });
    node.addEventListener('gestureend', onGestureEnd as EventListener, { passive: false });

    return () => {
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('gesturestart', onGestureStart as EventListener);
      node.removeEventListener('gesturechange', onGestureChange as EventListener);
      node.removeEventListener('gestureend', onGestureEnd as EventListener);
    };
  }, [scale, zoomAt]);

  // A gesture that landed inside a frame: the frame forwarded it up (the parent
  // never sees a cross-origin document's wheel events), with the point in that
  // frame's own pixels. Map it back through the frame's on-screen box so the
  // zoom still happens where the user's fingers are.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: string;
        deltaY?: number;
        factor?: number;
        x?: number;
        y?: number;
      } | null;
      const wheeling = data?.type === 'ss:wheelZoom' && typeof data.deltaY === 'number';
      const pinching = data?.type === 'ss:zoomBy' && typeof data.factor === 'number';
      if (!wheeling && !pinching) return;
      const node = scrollRef.current;
      if (!node) return;
      // Only this canvas's own frames may drive it.
      let frame: HTMLIFrameElement | null = null;
      for (const element of frameElsRef.current.values()) {
        if (element && element.contentWindow === event.source) frame = element;
      }
      if (!frame) return;
      const canvasBox = node.getBoundingClientRect();
      // Already the post-transform box, which is the space the pointer lives in.
      const frameBox = frame.getBoundingClientRect();
      const next = wheeling
        ? wheelZoom(scale, data?.deltaY ?? 0)
        : clampZoom(scale * (data?.factor ?? 1));
      zoomAt(
        next,
        frameBox.left - canvasBox.left + (data?.x ?? 0) * scale,
        frameBox.top - canvasBox.top + (data?.y ?? 0) * scale
      );
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [scale, zoomAt]);

  // Frames scroll together. Each one is a real viewport, so getting past the
  // fold means scrolling — and scrolling four frames by hand to compare the
  // same section is the whole thing this view exists to avoid. Position travels
  // as a FRACTION of each page's scrollable range, because the same page is a
  // different length at every width.
  const lastBroadcastRef = useRef({ fraction: -1, at: 0 });
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; fraction?: number } | null;
      if (data?.type !== 'ss:scroll' || typeof data.fraction !== 'number') return;
      const fraction = data.fraction;

      // A driven frame reports its new position once it settles, which is the
      // position we just sent it. Rebroadcasting that is a loop that damps out
      // but never quite stops, so recognise our own echo and drop it.
      const last = lastBroadcastRef.current;
      const echo =
        Math.abs(fraction - last.fraction) < SCROLL_ECHO_EPSILON &&
        Date.now() - last.at < SCROLL_ECHO_WINDOW_MS;
      if (echo) return;
      lastBroadcastRef.current = { fraction, at: Date.now() };

      for (const element of frameElsRef.current.values()) {
        // Not back to the frame that just moved — it is already there, and the
        // round trip would fight the user's own scrolling.
        if (!element || element.contentWindow === event.source) continue;
        try {
          element.contentWindow?.postMessage({ type: 'ss:scrollTo', fraction }, '*');
        } catch {
          // A frame mid-navigation can refuse; the next scroll catches it up.
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Cmd/Ctrl with +, - and 0 (fit). Cmd+1-9 belong to project switching, so
  // 100% has no shortcut of its own — the readout in the zoom control is the
  // way back to it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      if (isTypingTarget(event.target)) return;
      if (event.key === '=' || event.key === '+') {
        event.preventDefault();
        zoomFromCentre('in');
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        zoomFromCentre('out');
      } else if (event.key === '0') {
        event.preventDefault();
        onZoomChange('fit');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [zoomFromCentre, onZoomChange]);

  // ── Pan ─────────────────────────────────────────────
  // Space-drag and middle-drag, the two canvas idioms. Two-finger scrolling is
  // the browser's own; a gesture that lands inside a frame comes back to us
  // through the frame's own forwarder (above).
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat) return;
      if (isTypingTarget(event.target)) return;
      setSpaceHeld(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceHeld(false);
    };
    // A window that loses focus mid-drag never delivers the keyup.
    const onBlur = () => setSpaceHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const handlePanStart = useCallback(
    (event: React.MouseEvent) => {
      const node = scrollRef.current;
      if (!node) return;
      const middleButton = event.button === 1;
      if (!middleButton && !(spaceHeld && event.button === 0)) return;
      event.preventDefault();
      setPanning(true);
      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = node.scrollLeft;
      const startTop = node.scrollTop;
      const onMove = (move: MouseEvent) => {
        node.scrollLeft = startLeft - (move.clientX - startX);
        node.scrollTop = startTop - (move.clientY - startY);
      };
      const onUp = () => {
        setPanning(false);
        setScrollLeft(node.scrollLeft);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [spaceHeld]
  );

  // Zooming in past "fit" can leave the active frame off screen; keep it centred.
  // Only when Fit is switched on or off. A zoom gesture parks its own anchor
  // (above), and re-centring on every tick would fight the pointer.
  const previousFitRef = useRef(zoom === 'fit');
  useEffect(() => {
    const isFit = zoom === 'fit';
    if (previousFitRef.current === isFit) return;
    previousFitRef.current = isFit;
    // A gesture that just anchored itself at the pointer owns the scroll
    // position — this is the "left Fit by pinching" case, and re-centring here
    // would throw away the place the user zoomed into.
    if (anchoredRef.current) {
      anchoredRef.current = false;
      return;
    }
    const node = scrollRef.current;
    if (!node) return;
    if (isFit) {
      // Fit shows everything; centre the lot rather than one frame of it.
      // Measured after the layout the new scale produces, hence the frame.
      requestAnimationFrame(() => {
        const rest = restingScroll();
        node.scrollLeft = rest.left;
        node.scrollTop = rest.top;
        setScrollLeft(node.scrollLeft);
      });
      return;
    }
    node.scrollLeft = scrollToCenterFrame(layout, activeFrameId, zoom, node.clientWidth, slackX);
  }, [zoom, layout, activeFrameId, slackX, restingScroll]);

  // The frames sit `slack` into the surface, so any change in the slack moves
  // them under the viewport: on the first measurement (slack 0 → half a pane,
  // which is what lands the canvas on the frames instead of in the empty margin
  // beside them) and on every window resize after that. Compensating by the
  // delta keeps whatever the user was looking at where it was — and, unlike a
  // one-shot "scroll onto the content", it cannot miss its moment and leave the
  // canvas stranded in the void.
  const appliedSlackRef = useRef<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || viewport.width <= 0) return;
    const applied = appliedSlackRef.current;
    if (applied && applied.x === slackX && applied.y === slackY) return;
    const firstMeasurement = applied === null;
    appliedSlackRef.current = { x: slackX, y: slackY };
    if (firstMeasurement) {
      // Opening shot: land on the frames, centred.
      const rest = restingScroll();
      node.scrollLeft = rest.left;
      node.scrollTop = rest.top;
    } else {
      // A resize moved the frames within the surface; follow them so whatever
      // the user was looking at stays where it was.
      node.scrollLeft += slackX - applied.x;
      node.scrollTop += slackY - applied.y;
    }
    setScrollLeft(node.scrollLeft);
  }, [slackX, slackY, viewport.width, restingScroll]);

  return (
    <div
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
              height: `${stageHeight}px`,
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
                  <div className="preview-canvas-label" style={{ height: `${CANVAS_LABEL_PX}px` }}>
                    <span className="preview-canvas-label-name">{placement.label}</span>
                    <span className="preview-canvas-label-width">{placement.width}px</span>
                  </div>
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
                      title={`Work at ${placement.label} (${placement.width}px)`}
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
          onClick={() => onZoomChange(clampZoom(1))}
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
          onClick={() => onZoomChange('fit')}
          aria-pressed={zoom === 'fit'}
          title={`Fit every breakpoint (${kbd('mod', '0')})`}
        >
          Fit
        </Button>
      </div>
    </div>
  );
}
