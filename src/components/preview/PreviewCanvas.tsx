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
  anchorScroll,
  clampZoom,
  fitScale,
  frameHeight,
  layoutFrames,
  scrollToCenterFrame,
  stepZoom,
  visibleFrameIds,
  wheelZoom,
  type CanvasFrame,
} from '../../lib/previewCanvas';
import { Button } from '../primitives/Button';
import { kbd } from '../../lib/shortcuts';

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
  // Frame height is fixed at the FIT scale, not the current one: zooming must
  // magnify the page, not hand it a different viewport. (A frame that shrank as
  // you zoomed in would re-evaluate the page's own `vh` units and media queries
  // under you.) Zooming in therefore makes the surface taller than the pane and
  // the canvas pans vertically, exactly like any other design canvas.
  const stageHeight = frameHeight(viewport.height - CANVAS_LABEL_PX - CANVAS_PADDING_PX, fitted);
  const surfaceWidth = layout.contentWidth * scale;
  const surfaceHeight = CANVAS_LABEL_PX + stageHeight * scale + CANVAS_PADDING_PX;

  const mounted = useMemo(
    () => new Set(visibleFrameIds(layout, scale, scrollLeft, viewport.width)),
    [layout, scale, scrollLeft, viewport.width]
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

  // Scroll drives the mount window; rAF-throttled so a flung scrollbar doesn't
  // re-run the layout maths per frame.
  const scrollRafRef = useRef<number | null>(null);
  const handleScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      setScrollLeft(scrollRef.current?.scrollLeft ?? 0);
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

  useEffect(() => {
    onStageHeightChange?.(stageHeight);
  }, [stageHeight, onStageHeightChange]);

  // ── Zoom at the pointer ────────────────────────────────────
  // A zoom change goes through state, so the scroll correction that keeps the
  // point under the cursor in place has to wait for the new layout: it is
  // parked here and applied in the layout effect below, before paint.
  const pendingAnchorRef = useRef<{ scrollLeft: number; scrollTop: number } | null>(null);
  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current;
    const node = scrollRef.current;
    if (!pending || !node) return;
    pendingAnchorRef.current = null;
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
      });
      onZoomChange(nextScale);
    },
    [scale, onZoomChange]
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
    return () => node.removeEventListener('wheel', onWheel);
  }, [scale, zoomAt]);

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
  // the browser's own and needs nothing from us — except over the active frame,
  // which is a live page and eats the gesture (see `modifierHeld` below).
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

  // A wheel gesture over the ACTIVE frame belongs to that page — it is a live
  // document and scrolling it is the point. But the frame is cross-origin, so
  // the parent never sees those events, and a canvas zoom over it would do
  // nothing. Holding ⌘/Ctrl (which the user is already doing to zoom) lifts the
  // frames out of the way so the whole canvas is one zoom surface.
  const [modifierHeld, setModifierHeld] = useState(false);
  useEffect(() => {
    const sync = (event: KeyboardEvent) => setModifierHeld(event.metaKey || event.ctrlKey);
    const clear = () => setModifierHeld(false);
    window.addEventListener('keydown', sync);
    window.addEventListener('keyup', sync);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', sync);
      window.removeEventListener('keyup', sync);
      window.removeEventListener('blur', clear);
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
    if (pendingAnchorRef.current) return;
    const node = scrollRef.current;
    if (!node) return;
    const nextScale = isFit ? fitScale(layout.contentWidth, node.clientWidth) : zoom;
    node.scrollLeft = scrollToCenterFrame(layout, activeFrameId, nextScale, node.clientWidth);
  }, [zoom, layout, activeFrameId]);

  return (
    <div
      className={`preview-canvas-root${spaceHeld ? ' is-pannable' : ''}${
        panning ? ' is-panning' : ''
      }${modifierHeld ? ' is-zooming' : ''}`}
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
              top: `${CANVAS_LABEL_PX}px`,
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
                  height: `${stageHeight}px`,
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
                    left: `${placement.x * scale}px`,
                    width: `${placement.width * scale}px`,
                    height: `${CANVAS_LABEL_PX + stageHeight * scale}px`,
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
