/**
 * Where the breakpoint canvas sits, and who decided that.
 *
 * The canvas has one job here that sounds trivial and is not: it must always be
 * showing the frames. The pane's FIRST measured size cannot be trusted — a
 * webview commits the mount before the pane has settled — so a canvas that
 * treats its opening position as a one-off is one bad number away from being
 * parked in the pan slack for good, which the user sees as an empty grey pane.
 *
 * Three rules, in order of how much they know:
 *
 * 1. Until the user places the canvas themselves, it is simply **centred on
 *    every measurement**. Re-centring is idempotent, so being told the size
 *    three times costs nothing. Fit is a standing instruction of the same kind:
 *    while it is on, a pane that changes shape re-centres regardless.
 * 2. Once the position is theirs, a resize **compensates by the slack delta**,
 *    so whatever they were looking at stays where it was.
 * 3. Whatever the arithmetic decided, the **laid-out boxes** are checked: if
 *    not one frame overlaps the visible box, the canvas re-centres. Measured
 *    from the DOM rather than from the numbers that produced it, so a wrong
 *    number cannot also rule that everything is fine.
 *
 * Ownership is taken by INPUT — a wheel, a pan, a zoom — and never by a
 * `scroll` event. The browser fires those for its own reasons, including
 * adjusting the offset when content grows, which is exactly what happens as the
 * frames learn how long their pages are.
 *
 * @module hooks/useCanvasPlacement
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** How long the canvas stays "in use" after the last gesture. Long enough to
 *  cover the gap between two flicks, short enough not to hold a compositor
 *  hint on a very large layer while the user reads. */
const INTERACTION_TAIL_MS = 300;

interface UseCanvasPlacementParams {
  /** The scrolling canvas element. */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Visible canvas box, screen pixels. */
  viewport: { width: number; height: number };
  /** Where the frames start inside the surface. */
  slackX: number;
  slackY: number;
  /** The frames' on-screen extent, screen pixels. */
  contentWidthPx: number;
  contentHeightPx: number;
  /** Whether the canvas is fitting — a standing instruction to show it all. */
  isFit: boolean;
  /** Anything that changes the laid-out geometry, so rule 3 knows to look. */
  geometryToken: unknown;
  /** Called after the canvas has placed itself. */
  onScrollSettled: (scrollLeft: number) => void;
}

export interface CanvasPlacement {
  /** The canvas position is now the user's doing. */
  markUserMoved: () => void;
  /** Hand it back: Fit re-centres and keeps re-centring. */
  releaseToCanvas: () => void;
  /** The user is moving the canvas right now (plus a short tail). */
  interacting: boolean;
  /** Where the canvas rests: the frames centred in the pane. */
  restingScroll: () => { left: number; top: number };
  /** Place the canvas without that counting as the user placing it. */
  parkScrollNow: (node: HTMLDivElement, left: number, top: number) => void;
}

export function useCanvasPlacement({
  scrollRef,
  viewport,
  slackX,
  slackY,
  contentWidthPx,
  contentHeightPx,
  isFit,
  geometryToken,
  onScrollSettled,
}: UseCanvasPlacementParams): CanvasPlacement {
  const userMovedRef = useRef(false);

  const settledRef = useRef(onScrollSettled);
  useEffect(() => {
    settledRef.current = onScrollSettled;
  }, [onScrollSettled]);

  const parkScrollNow = useCallback((node: HTMLDivElement, left: number, top: number) => {
    node.scrollLeft = left;
    node.scrollTop = top;
  }, []);

  // While the user is actually moving the canvas, the scaled layer is promoted
  // to its own compositor layer so a zoom is a transform rather than four
  // enormous frames being rasterised again. Dropped a beat after they stop —
  // `will-change` on a layer that size is not free to hold.
  const [interacting, setInteracting] = useState(false);
  const interactingTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (interactingTimerRef.current !== null) clearTimeout(interactingTimerRef.current);
    },
    []
  );

  const markUserMoved = useCallback(() => {
    userMovedRef.current = true;
    setInteracting(true);
    if (interactingTimerRef.current !== null) clearTimeout(interactingTimerRef.current);
    interactingTimerRef.current = window.setTimeout(() => {
      interactingTimerRef.current = null;
      setInteracting(false);
    }, INTERACTION_TAIL_MS);
  }, []);

  const releaseToCanvas = useCallback(() => {
    userMovedRef.current = false;
  }, []);

  // A wheel is the user placing the canvas. A scroll event is not.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.addEventListener('wheel', markUserMoved, { passive: true });
    return () => node.removeEventListener('wheel', markUserMoved);
  }, [markUserMoved, scrollRef]);

  const restingScroll = useCallback(
    () => ({
      left: Math.max(0, slackX - Math.max(0, (viewport.width - contentWidthPx) / 2)),
      top: Math.max(0, slackY - Math.max(0, (viewport.height - contentHeightPx) / 2)),
    }),
    [slackX, slackY, viewport.width, viewport.height, contentWidthPx, contentHeightPx]
  );

  // Rules 1 and 2.
  const appliedSlackRef = useRef<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || viewport.width <= 0) return;
    const applied = appliedSlackRef.current;
    const owned = userMovedRef.current && !isFit;
    if (owned && applied && applied.x === slackX && applied.y === slackY) return;
    appliedSlackRef.current = { x: slackX, y: slackY };
    if (!owned) {
      const rest = restingScroll();
      parkScrollNow(node, rest.left, rest.top);
    } else if (applied) {
      parkScrollNow(
        node,
        node.scrollLeft + slackX - applied.x,
        node.scrollTop + slackY - applied.y
      );
    }
    settledRef.current(node.scrollLeft);
  }, [slackX, slackY, viewport.width, isFit, restingScroll, parkScrollNow, scrollRef]);

  // Rule 3: a canvas you cannot lose.
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
    // and publishing from here would be a set inside an effect that reads
    // layout — one bad measurement away from a loop.
    const rest = restingScroll();
    parkScrollNow(node, rest.left, rest.top);
  }, [geometryToken, viewport.width, viewport.height, restingScroll, parkScrollNow, scrollRef]);

  return { markUserMoved, releaseToCanvas, interacting, restingScroll, parkScrollNow };
}
