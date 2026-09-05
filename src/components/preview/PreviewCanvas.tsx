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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CANVAS_LABEL_PX,
  CANVAS_PADDING_PX,
  ZOOM_STEPS,
  fitScale,
  frameHeight,
  layoutFrames,
  scrollToCenterFrame,
  visibleFrameIds,
  type CanvasFrame,
} from '../../lib/previewCanvas';
import { Button } from '../primitives/Button';

/** `'fit'` recomputes on every resize; a number is an explicit zoom level. */
export type CanvasZoom = 'fit' | number;

interface PreviewCanvasProps {
  /** Frames to render, widest first. */
  frames: CanvasFrame[];
  /** URL every frame loads. */
  url: string;
  /** The interactive/editable frame. */
  activeFrameId: string;
  /** Bumped by the preview's refresh action — remounts every frame. */
  reloadToken: number;
  zoom: CanvasZoom;
  onZoomChange: (zoom: CanvasZoom) => void;
  /** A frame was clicked (or its label picked): make it the active one. */
  onActivateFrame: (frameId: string) => void;
  /** The active frame's element, or null while it isn't mounted. The visual
   *  editor binds to whatever this reports. */
  onActiveFrameElement: (element: HTMLIFrameElement | null) => void;
}

export function PreviewCanvas({
  frames,
  url,
  activeFrameId,
  reloadToken,
  zoom,
  onZoomChange,
  onActivateFrame,
  onActiveFrameElement,
}: PreviewCanvasProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const frameElsRef = useRef(new Map<string, HTMLIFrameElement | null>());

  // Visible canvas box (screen pixels) and scroll offset, both driving which
  // frames stay mounted and how large the fit scale is.
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scrollLeft, setScrollLeft] = useState(0);

  const layout = useMemo(() => layoutFrames(frames), [frames]);

  const scale = zoom === 'fit' ? fitScale(layout.contentWidth, viewport.width) : zoom;
  const stageHeight = frameHeight(viewport.height - CANVAS_LABEL_PX - CANVAS_PADDING_PX, scale);
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

  // Zooming in past "fit" can leave the active frame off screen; keep it centred.
  const previousZoomRef = useRef(zoom);
  useEffect(() => {
    if (previousZoomRef.current === zoom) return;
    previousZoomRef.current = zoom;
    const node = scrollRef.current;
    if (!node) return;
    const nextScale = zoom === 'fit' ? fitScale(layout.contentWidth, node.clientWidth) : zoom;
    node.scrollLeft = scrollToCenterFrame(layout, activeFrameId, nextScale, node.clientWidth);
  }, [zoom, layout, activeFrameId]);

  return (
    <div className="preview-canvas-root">
      <div className="preview-canvas" ref={setScrollEl} onScroll={handleScroll}>
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
                    src={url}
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
                    <div className="preview-canvas-outline" aria-hidden />
                  ) : (
                    <button
                      type="button"
                      className="preview-canvas-activate"
                      onClick={() => onActivateFrame(placement.id)}
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
          variant={zoom === 'fit' ? 'secondary' : 'ghost'}
          onClick={() => onZoomChange('fit')}
          aria-pressed={zoom === 'fit'}
        >
          Fit
        </Button>
        {ZOOM_STEPS.map((step) => (
          <Button
            key={step}
            size="compact"
            variant={zoom === step ? 'secondary' : 'ghost'}
            onClick={() => onZoomChange(step)}
            aria-pressed={zoom === step}
          >
            {Math.round(step * 100)}%
          </Button>
        ))}
      </div>
    </div>
  );
}
