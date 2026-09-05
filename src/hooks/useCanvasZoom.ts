/**
 * Zoom for the breakpoint canvas: every way in, and one way of applying it.
 *
 * The hard part isn't the arithmetic, it's the anchoring. A zoom goes through
 * React state, so the scroll correction that keeps the point under the pointer
 * in place has to wait for the layout the new scale produces — it is parked
 * here and applied in a layout effect, before paint.
 *
 * The other hard part is that a gesture over a frame never reaches this window:
 * frames are cross-origin documents and get their own wheel and gesture events.
 * The injected preview script forwards them back up, and they arrive here as
 * messages carrying a point in that frame's own pixels.
 *
 * @module hooks/useCanvasZoom
 */

import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import {
  CANVAS_LABEL_PX,
  anchorScroll,
  clampZoom,
  stepZoom,
  wheelZoom,
} from '../lib/previewCanvas';

/** WebKit's non-standard pinch events (Safari, and every Tauri webview on
 *  macOS). Not in lib.dom, so the shape used here is spelled out. */
interface GestureLikeEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

/** A keyboard shortcut must not fire while the user is typing somewhere. */
const isTypingTarget = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  if (!element) return false;
  if (element.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName ?? '');
};

interface UseCanvasZoomParams {
  /** The scrolling canvas element. */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** The canvas's frames, so a forwarded gesture can be traced to one of them
   *  (and one from anywhere else ignored). */
  frameElsRef: RefObject<Map<string, HTMLIFrameElement | null>>;
  /** The scale currently rendered. */
  scale: number;
  /** Where the frames start inside the surface. */
  slackX: number;
  slackY: number;
  onZoomChange: (zoom: number) => void;
  /** Fit the whole canvas — Cmd+0, and the same thing the Fit button does.
   *  Owned by the canvas because fitting also re-centres. */
  onFit: () => void;
  /** Called after a parked scroll position has been applied. */
  onScrollSettled: (scrollLeft: number) => void;
}

export interface CanvasZoomControls {
  /** Zoom, keeping the canvas point at (pointerX, pointerY) under it. */
  zoomAt: (nextScale: number, pointerX: number, pointerY: number) => void;
  /** One step in or out, about the middle of the canvas — for the buttons and
   *  the keyboard, which have no pointer to zoom around. */
  zoomFromCentre: (direction: 'in' | 'out') => void;
  /** Park an absolute scroll position to apply with the next scale change. */
  parkScroll: (position: { scrollLeft: number; scrollTop: number }) => void;
  /** Whether the scroll position was just placed by a zoom — the canvas asks
   *  before re-centring on anything else, and asking clears it. */
  consumeAnchored: () => boolean;
}

export function useCanvasZoom({
  scrollRef,
  frameElsRef,
  scale,
  slackX,
  slackY,
  onZoomChange,
  onFit,
  onScrollSettled,
}: UseCanvasZoomParams): CanvasZoomControls {
  const pendingRef = useRef<{ scrollLeft: number; scrollTop: number } | null>(null);
  const anchoredRef = useRef(false);

  const settledRef = useRef(onScrollSettled);
  useEffect(() => {
    settledRef.current = onScrollSettled;
  }, [onScrollSettled]);

  useLayoutEffect(() => {
    const pending = pendingRef.current;
    const node = scrollRef.current;
    if (!pending || !node) return;
    pendingRef.current = null;
    anchoredRef.current = true;
    node.scrollLeft = pending.scrollLeft;
    node.scrollTop = pending.scrollTop;
    settledRef.current(node.scrollLeft);
  }, [scale, scrollRef]);

  const parkScroll = useCallback((position: { scrollLeft: number; scrollTop: number }) => {
    pendingRef.current = position;
  }, []);

  const consumeAnchored = useCallback(() => {
    const anchored = anchoredRef.current;
    anchoredRef.current = false;
    return anchored;
  }, []);

  const zoomAt = useCallback(
    (nextScale: number, pointerX: number, pointerY: number) => {
      const node = scrollRef.current;
      if (!node || nextScale === scale) return;
      pendingRef.current = anchorScroll({
        scrollLeft: node.scrollLeft,
        scrollTop: node.scrollTop,
        pointerX,
        pointerY,
        fromScale: scale,
        toScale: nextScale,
        originX: slackX,
        // The frames start BELOW the label row, and that row is unscaled — leave
        // it out and the anchor drifts vertically by exactly
        // labelHeight × (1 − newScale / oldScale).
        originY: slackY + CANVAS_LABEL_PX,
      });
      onZoomChange(nextScale);
    },
    [scale, slackX, slackY, onZoomChange, scrollRef]
  );

  const zoomFromCentre = useCallback(
    (direction: 'in' | 'out') => {
      const node = scrollRef.current;
      zoomAt(
        stepZoom(scale, direction),
        (node?.clientWidth ?? 0) / 2,
        (node?.clientHeight ?? 0) / 2
      );
    },
    [scale, zoomAt, scrollRef]
  );

  // Gestures that land on the canvas itself. Registered by hand because they
  // must be non-passive: without preventDefault the gesture zooms the whole app
  // window instead of the canvas.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const box = node.getBoundingClientRect();
      zoomAt(wheelZoom(scale, event.deltaY), event.clientX - box.left, event.clientY - box.top);
    };

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

    node.addEventListener('wheel', onWheel, { passive: false });
    node.addEventListener('gesturestart', onGestureStart as EventListener, { passive: false });
    node.addEventListener('gesturechange', onGestureChange as EventListener, { passive: false });
    node.addEventListener('gestureend', onGestureEnd as EventListener, { passive: false });
    return () => {
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('gesturestart', onGestureStart as EventListener);
      node.removeEventListener('gesturechange', onGestureChange as EventListener);
      node.removeEventListener('gestureend', onGestureEnd as EventListener);
    };
  }, [scale, zoomAt, scrollRef]);

  // Gestures that landed inside a frame, forwarded up by the injected script
  // with the point in that frame's own pixels. Mapped back through the frame's
  // on-screen box so the zoom still happens where the user's fingers are.
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
      for (const element of frameElsRef.current?.values() ?? []) {
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
  }, [scale, zoomAt, scrollRef, frameElsRef]);

  // ⌘/Ctrl with +, − and 0 (fit). ⌘1–9 belong to project switching, so 100% has
  // no shortcut of its own — the readout in the zoom control is the way back.
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
        onFit();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [zoomFromCentre, onFit]);

  return { zoomAt, zoomFromCentre, parkScroll, consumeAnchored };
}
