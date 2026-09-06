/**
 * Every way of moving the breakpoint canvas that is not a mouse drag: the
 * wheel, the trackpad, and the keyboard.
 *
 * All of them end at the same two calls — `camera.panBy` and `camera.zoomAt` —
 * and none of them go through React. That is deliberate and it is the whole
 * point: a gesture outruns rendering. A trackpad delivers events faster than
 * the canvas can paint, so anything that reads the zoom level out of a render,
 * or writes one back per event, turns a gesture into a slideshow. The live
 * camera is a ref (`useCanvasCamera`); this file only decides what each event
 * means.
 *
 * Two consequences worth knowing:
 *
 * - **The listeners are registered exactly once.** A listener set torn down and
 *   rebuilt whenever the scale changed would lose the pinch baseline it was
 *   accumulating, and the next event of a gesture already in flight would
 *   measure itself against nothing.
 * - **A gesture over a frame never reaches this window.** Frames are
 *   cross-origin documents and get their own wheel and gesture events; the
 *   injected preview script forwards them back up, and they arrive here as
 *   messages carrying a point in that frame's own pixels. Wheels the page had
 *   no scroll left to spend arrive as `ss:panBy` and are wired straight to the
 *   camera by the canvas, so a wheel over a frame and a wheel over the
 *   background are the same gesture on the same path — which is the reason
 *   panning no longer changes character depending on where the pointer is.
 *
 * @module hooks/useCanvasGestures
 */

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { clampZoom, stepZoom, wheelZoom } from '../lib/previewCanvas';
import type { CanvasCameraControls } from './useCanvasCamera';

/** WebKit's non-standard pinch events (Safari, and every Tauri webview on
 *  macOS). Not in lib.dom, so the shape used here is spelled out. */
interface GestureLikeEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

/** `deltaMode` 1 is lines, not pixels — a few mice and most of Firefox. The
 *  canvas works in pixels, and a line is about one line of text. */
const LINE_HEIGHT_PX = 16;

/** A keyboard shortcut must not fire while the user is typing somewhere. */
const isTypingTarget = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  if (!element) return false;
  if (element.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName ?? '');
};

interface UseCanvasGesturesParams {
  /** The visible canvas box — gestures are measured against it. */
  viewportRef: RefObject<HTMLDivElement | null>;
  /** The camera every gesture moves. */
  camera: CanvasCameraControls;
  /** The canvas's frames, so a forwarded gesture can be traced to one of them
   *  (and one from anywhere else ignored). */
  frameElsRef: RefObject<Map<string, HTMLIFrameElement | null>>;
  /** The user has taken the canvas position into their own hands. */
  onUserMoved: () => void;
  /** Fit the whole canvas — Cmd+0, and the same thing the Fit button does.
   *  Owned by the canvas because fitting also re-centres. */
  onFit: () => void;
}

export interface CanvasGestures {
  /** One step in or out, about the middle of the canvas — for the buttons and
   *  the keyboard, which have no pointer to zoom around. */
  zoomFromCentre: (direction: 'in' | 'out') => void;
  /** Whether the camera was just placed by a zoom anchored at a point — the
   *  canvas asks before re-centring on anything else, and asking clears it. */
  consumeAnchored: () => boolean;
}

export function useCanvasGestures({
  viewportRef,
  camera,
  frameElsRef,
  onUserMoved,
  onFit,
}: UseCanvasGesturesParams): CanvasGestures {
  const anchoredRef = useRef(false);

  const movedRef = useRef(onUserMoved);
  useEffect(() => {
    movedRef.current = onUserMoved;
  }, [onUserMoved]);

  const fitRef = useRef(onFit);
  useEffect(() => {
    fitRef.current = onFit;
  }, [onFit]);

  const zoomAt = useCallback(
    (nextScale: number, pointerX: number, pointerY: number) => {
      movedRef.current();
      anchoredRef.current = true;
      camera.zoomAt(nextScale, pointerX, pointerY);
    },
    [camera]
  );

  const panBy = useCallback(
    (dx: number, dy: number) => {
      movedRef.current();
      camera.panBy(dx, dy);
    },
    [camera]
  );

  const consumeAnchored = useCallback(() => {
    const anchored = anchoredRef.current;
    anchoredRef.current = false;
    return anchored;
  }, []);

  const zoomFromCentre = useCallback(
    (direction: 'in' | 'out') => {
      const node = viewportRef.current;
      zoomAt(
        stepZoom(camera.read().scale, direction),
        (node?.clientWidth ?? 0) / 2,
        (node?.clientHeight ?? 0) / 2
      );
    },
    [zoomAt, camera, viewportRef]
  );

  // Gestures that land on the canvas itself. Registered by hand because they
  // must be non-passive: the canvas no longer scrolls natively, so without
  // preventDefault a wheel would scroll an ancestor and a pinch would zoom the
  // whole app window. Registered ONCE — see the module note.
  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = node.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        zoomAt(
          wheelZoom(camera.read().scale, event.deltaY),
          event.clientX - box.left,
          event.clientY - box.top
        );
        return;
      }
      // An ordinary two-finger scroll pans. macOS keeps delivering these
      // through the momentum phase after the fingers lift, so the flick and its
      // glide are the same stream of events and the canvas coasts for free.
      const factor = event.deltaMode === 1 ? LINE_HEIGHT_PX : 1;
      panBy(event.deltaX * factor, event.deltaY * factor);
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
      zoomAt(
        clampZoom(camera.read().scale * factor),
        event.clientX - box.left,
        event.clientY - box.top
      );
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
  }, [zoomAt, panBy, camera, viewportRef]);

  // Zoom gestures that landed inside a frame, forwarded up by the injected
  // script with the point in that frame's own pixels. Mapped back through the
  // frame's on-screen box so the zoom still happens where the fingers are.
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

      const node = viewportRef.current;
      if (!node) return;
      // Only this canvas's own frames may drive it.
      let frame: HTMLIFrameElement | null = null;
      for (const element of frameElsRef.current?.values() ?? []) {
        if (element && element.contentWindow === event.source) frame = element;
      }
      if (!frame) return;

      const live = camera.read().scale;
      const canvasBox = node.getBoundingClientRect();
      // Already the post-transform box, which is the space the pointer lives in.
      const frameBox = frame.getBoundingClientRect();
      const next = wheeling
        ? wheelZoom(live, data?.deltaY ?? 0)
        : clampZoom(live * (data?.factor ?? 1));
      zoomAt(
        next,
        frameBox.left - canvasBox.left + (data?.x ?? 0) * live,
        frameBox.top - canvasBox.top + (data?.y ?? 0) * live
      );
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [zoomAt, camera, viewportRef, frameElsRef]);

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
        fitRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [zoomFromCentre]);

  return { zoomFromCentre, consumeAnchored };
}
