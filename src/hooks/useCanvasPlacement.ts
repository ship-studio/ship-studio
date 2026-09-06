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
 * Ownership is taken by INPUT — a wheel, a pan, a zoom — and never by the
 * camera arriving somewhere. Things other than the user move the camera,
 * including this file.
 *
 * @module hooks/useCanvasPlacement
 */

import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import type { CanvasCameraControls } from './useCanvasCamera';

interface UseCanvasPlacementParams {
  /** The camera these rules move. */
  camera: CanvasCameraControls;
  /** Whether a gesture is in flight — rule 4 waits for one to finish. */
  interacting: boolean;
  /** The canvas root, for reading the laid-out boxes rule 3 checks. */
  rootRef: RefObject<HTMLDivElement | null>;
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
  /** The rendered scale. Rule 4 uses it to tell a zoom from a pan. */
  scale: number;
  /** Anything that changes the laid-out geometry, so rule 3 knows to look. */
  geometryToken: unknown;
}

export interface CanvasPlacement {
  /** The canvas position is now the user's doing. */
  markUserMoved: () => void;
  /** Hand it back: Fit re-centres and keeps re-centring. */
  releaseToCanvas: () => void;
  /** Where the canvas rests: the frames centred in the pane. */
  restingCamera: () => { x: number; y: number };
}

export function useCanvasPlacement({
  camera,
  interacting,
  rootRef,
  viewport,
  slackX,
  slackY,
  contentWidthPx,
  contentHeightPx,
  isFit,
  scale,
  geometryToken,
}: UseCanvasPlacementParams): CanvasPlacement {
  const userMovedRef = useRef(false);

  const markUserMoved = useCallback(() => {
    userMovedRef.current = true;
  }, []);

  const releaseToCanvas = useCallback(() => {
    userMovedRef.current = false;
  }, []);

  const restingCamera = useCallback(
    () => ({
      x: Math.max(0, slackX - Math.max(0, (viewport.width - contentWidthPx) / 2)),
      y: Math.max(0, slackY - Math.max(0, (viewport.height - contentHeightPx) / 2)),
    }),
    [slackX, slackY, viewport.width, viewport.height, contentWidthPx, contentHeightPx]
  );

  // Rules 1 and 2.
  const appliedSlackRef = useRef<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (viewport.width <= 0) return;
    const applied = appliedSlackRef.current;
    const owned = userMovedRef.current && !isFit;
    if (owned && applied && applied.x === slackX && applied.y === slackY) return;
    appliedSlackRef.current = { x: slackX, y: slackY };
    if (!owned) {
      camera.place(restingCamera());
    } else if (applied) {
      const current = camera.read();
      camera.place({ x: current.x + slackX - applied.x, y: current.y + slackY - applied.y });
    }
    camera.commit();
  }, [slackX, slackY, viewport.width, isFit, restingCamera, camera]);

  // Rule 3: a canvas you cannot lose.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || viewport.width <= 0) return;
    const box = root.getBoundingClientRect();
    // Nothing measurable to reason about — a pane that hasn't been laid out, or
    // an environment that doesn't do layout at all. Silence is not evidence
    // that the canvas is lost.
    if (box.width <= 0 || box.height <= 0) return;
    const chrome = root.querySelectorAll('.preview-canvas-chrome');
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
    camera.place(restingCamera());
    camera.commit();
  }, [geometryToken, viewport.width, viewport.height, restingCamera, camera, rootRef]);

  // Rule 4: a zoom that no longer needs an axis gives it back.
  //
  // Zoom is anchored to the pointer, which is right and is what every canvas
  // tool does. But anchoring only says where the point under the cursor goes;
  // it says nothing about the axis the content has stopped filling. Zoom out
  // far enough and the frames stop needing the width of the pane, and they are
  // left wherever the arithmetic put them — pushed against an edge with most of
  // the canvas empty beside them. Nothing is lost, so rule 3 stays quiet: it
  // only speaks when NOT ONE frame overlaps the pane. The canvas is merely
  // useless, which it has no rule against.
  //
  // So when an axis is no longer needed — the content fits it — that axis is
  // recentred. Only on an axis that fits, so a canvas taller than the pane
  // keeps the vertical position the user zoomed to, and only when the SCALE
  // changed, so panning the frames somewhere deliberately is left alone. Waits
  // for the gesture to finish, because doing it mid-pinch is a fight — and it
  // runs off the RENDERED scale, which only changes once a gesture settles.
  const settledScaleRef = useRef(scale);
  useLayoutEffect(() => {
    if (interacting) return;
    if (viewport.width <= 0) return;
    if (settledScaleRef.current === scale) return;
    settledScaleRef.current = scale;
    const rest = restingCamera();
    const current = camera.read();
    camera.place({
      x: contentWidthPx <= viewport.width ? rest.x : current.x,
      y: contentHeightPx <= viewport.height ? rest.y : current.y,
    });
    camera.commit();
  }, [
    scale,
    interacting,
    contentWidthPx,
    contentHeightPx,
    viewport.width,
    viewport.height,
    restingCamera,
    camera,
  ]);

  return { markUserMoved, releaseToCanvas, restingCamera };
}
