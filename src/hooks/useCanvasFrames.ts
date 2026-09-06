/**
 * The breakpoint canvas's frames as *live documents*: which elements exist,
 * what each one has been told about the canvas around it, how long the page
 * inside it turned out to be, and the gestures it hands back up.
 *
 * Everything the canvas adds to a preview page is off until it is told
 * otherwise, so the ordinary single-frame preview costs exactly what it cost
 * before this feature existed. A frame is told twice — once when it registers,
 * and again on every `load`, because a reloaded document starts from those
 * defaults again.
 *
 * @module hooks/useCanvasFrames
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/** A page longer than this is a runaway — an infinite scroller, or a layout
 *  feeding back on the frame height — not a page. */
export const MAX_PAGE_HEIGHT_PX = 24000;

/**
 * Tell a frame it is part of a canvas, and what viewport height it is standing
 * in for. That height is what lets the frame show the WHOLE page while `100vh`
 * still means one screen.
 */
const announceCanvas = (frame: HTMLIFrameElement, on = true): void => {
  try {
    const viewportHeight = Number(frame.dataset.viewportHeight) || undefined;
    frame.contentWindow?.postMessage({ type: 'ss:canvas', on, vh: viewportHeight }, '*');
  } catch {
    // A frame mid-navigation can refuse; its load handler will say it again.
  }
};

/**
 * Tell a frame whether it is one nobody is working in — which is to say,
 * whether it is a background tab, because that is how it is then treated:
 * `hidden` is reported, and the JavaScript animation clock is suspended.
 *
 * Holding still is NOT this message's job. Every frame on a canvas holds still,
 * active or not, and `ss:canvas` says so — a canvas is a surface you read and
 * lay out against, and an animation there repaints a whole page forever for
 * nothing. What being active buys a frame is the right to be EDITED.
 */
const announcePassive = (frame: HTMLIFrameElement, passive: boolean): void => {
  try {
    frame.contentWindow?.postMessage({ type: 'ss:passive', on: passive }, '*');
  } catch {
    // Mid-navigation; the next announcement covers it.
  }
};

interface UseCanvasFramesParams {
  /** The interactive, editable frame. Every other frame is a review surface. */
  activeFrameId: string;
  /** The active frame's element, or null while it isn't mounted. */
  onActiveFrameElement: (element: HTMLIFrameElement | null) => void;
  /** A wheel a frame had no scroll left to spend. Screen pixels, one call per
   *  event — the caller decides how often to act on them. */
  onPanBy: (dx: number, dy: number) => void;
}

export interface CanvasFrames {
  /** Live frame elements by id. */
  frameElsRef: RefObject<Map<string, HTMLIFrameElement | null>>;
  /** Ref callback for every frame — ONE stable function, see below. */
  registerFrame: (element: HTMLIFrameElement) => (() => void) | undefined;
  /** What to call from each frame's `load`. */
  handleFrameLoad: (element: HTMLIFrameElement) => void;
  /** How long each page turned out to be, capped and keyed by frame id. */
  pageHeights: Record<string, number>;
}

export function useCanvasFrames({
  activeFrameId,
  onActiveFrameElement,
  onPanBy,
}: UseCanvasFramesParams): CanvasFrames {
  const frameElsRef = useRef(new Map<string, HTMLIFrameElement | null>());
  const [pageHeights, setPageHeights] = useState<Record<string, number>>({});

  const panRef = useRef(onPanBy);
  useEffect(() => {
    panRef.current = onPanBy;
  }, [onPanBy]);

  // ONE stable ref callback for every frame — a per-frame closure would be a
  // new function on each render, and React would detach and re-attach a live
  // iframe (unbinding and rebinding the editor) for no reason. The frame it
  // belongs to comes off the element's own `data-frame-id`, and the cleanup
  // return (React 19) is what tells us a frame went away. Registration bumps an
  // epoch; the effects below turn that into one announcement round.
  const [frameEpoch, setFrameEpoch] = useState(0);
  const registerFrame = useCallback((element: HTMLIFrameElement) => {
    const frameId = element.dataset.frameId;
    if (!frameId) return;
    frameElsRef.current.set(frameId, element);
    announceCanvas(element);
    setFrameEpoch((epoch) => epoch + 1);
    return () => {
      // Best effort: a frame going away because the canvas is closing should
      // stop forwarding gestures and rewriting its units. A frame going away
      // because it unmounted doesn't care.
      announceCanvas(element, false);
      frameElsRef.current.delete(frameId);
      setFrameEpoch((epoch) => epoch + 1);
    };
  }, []);

  const activeRef = useRef(activeFrameId);
  useEffect(() => {
    activeRef.current = activeFrameId;
  }, [activeFrameId]);
  const handleFrameLoad = useCallback((element: HTMLIFrameElement) => {
    announceCanvas(element);
    announcePassive(element, element.dataset.frameId !== activeRef.current);
  }, []);

  // Which frame is live and which are holding still. Re-announced whenever the
  // active frame changes or a frame (re)mounts, because a reloaded document
  // starts out live again.
  useEffect(() => {
    for (const [frameId, element] of frameElsRef.current.entries()) {
      if (element) announcePassive(element, frameId !== activeFrameId);
    }
  }, [activeFrameId, frameEpoch]);

  // Report the active frame's element upward whenever the binding could have
  // changed — a different frame, a remount, or the canvas going away.
  useEffect(() => {
    onActiveFrameElement(frameElsRef.current.get(activeFrameId) ?? null);
  }, [activeFrameId, frameEpoch, onActiveFrameElement]);
  useEffect(() => () => onActiveFrameElement(null), [onActiveFrameElement]);

  // Everything a frame reports back: how tall its page turned out to be, and
  // any gesture it could not use itself.
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
        const height = Math.min(MAX_PAGE_HEIGHT_PX, Math.round(data.height ?? 0));
        if (height <= 0) return;
        setPageHeights((current) =>
          current[frameId] === height ? current : { ...current, [frameId]: height }
        );
        return;
      }
      panRef.current(data.dx ?? 0, data.dy ?? 0);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return { frameElsRef, registerFrame, handleFrameLoad, pageHeights };
}
