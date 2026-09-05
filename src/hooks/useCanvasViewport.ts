/**
 * How big the breakpoint canvas's visible box is — the one number every other
 * decision on the canvas is made from: the fit scale, how far it may be pushed
 * past its frames, and where it rests.
 *
 * Getting it wrong is not a small error. The canvas SIZES ITS SURFACE from this
 * measurement and then lives inside the box it just sized, so measuring
 * anything that can grow with that surface is a feedback loop: it ran to
 * `height: 8658738px` in the app before this was pinned down, which the user
 * sees as a grey pane with nothing in it. Two rules keep it honest:
 *
 * 1. Measure the ROOT, never the scroller. The scroller contains the surface;
 *    the root holds nothing and is bounded by the pane.
 * 2. Clamp to the window. A pane cannot be bigger than the window it is in,
 *    whatever a stylesheet upstream decides to do.
 *
 * And measure more than once. A pane measured during the commit that mounts it
 * has not necessarily reached its final size, and the canvas built from that
 * first number is the one the user opens.
 *
 * @module hooks/useCanvasViewport
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface CanvasViewport {
  width: number;
  height: number;
}

export interface CanvasViewportControls {
  /** Ref callback for the canvas root — the element that gets measured. */
  setRootEl: (node: HTMLDivElement | null) => void;
  /** The visible box, in screen pixels. `{0, 0}` until it has been measured. */
  viewport: CanvasViewport;
}

export function useCanvasViewport(): CanvasViewportControls {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<CanvasViewport>({ width: 0, height: 0 });

  const measure = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
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

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure());
    observer?.observe(node);
    // A second source, because a webview can deliver its own resize before the
    // observer notices.
    window.addEventListener('resize', measure);
    // And one more read after the frame the canvas mounted in, for the case
    // where the pane was still settling when the ref callback measured it.
    const settle = requestAnimationFrame(measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      cancelAnimationFrame(settle);
    };
  }, [measure]);

  return { setRootEl, viewport };
}
