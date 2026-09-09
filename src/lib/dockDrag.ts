/**
 * Turning a pointer into a place to put a panel.
 *
 * Kept as pure functions over rectangles so the whole interaction can be
 * reasoned about — and tested — without a browser, a pointer, or a rendered
 * workspace. `WorkspaceDock` measures; this decides; `workspaceLayout` applies.
 *
 * ## The gesture
 *
 * A panel docks at a **boundary**: the outer edges of the rail, and every seam
 * between two things already in it. While dragging, the nearest boundary within
 * `SNAP_PX` wins and is drawn as an insertion line. Past that — which in
 * practice means out over the middle of the preview — nothing is near enough
 * and the panel floats.
 *
 * That is why the snap distance is generous. The alternative gesture, "drag it
 * out of the rail to float it", has nowhere to go: the rail *is* the workspace,
 * so leaving it means leaving the window. Making the canvas the float target
 * instead gives the drop somewhere to land and says what will happen while you
 * are still holding it.
 *
 * @module lib/dockDrag
 */

import {
  PREVIEW,
  movePanel,
  setFloating,
  type PanelId,
  type RailItem,
  type WorkspaceLayout,
} from './workspaceLayout';

/** How near a boundary the pointer must be for the drop to dock rather than float. */
export const SNAP_PX = 140;

/** A visible rail item's horizontal extent, in viewport coordinates. */
export interface RailSlotRect {
  item: RailItem;
  left: number;
  right: number;
}

export interface RailBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Where a release would put the panel. */
export type DropTarget =
  | {
      kind: 'dock';
      /** Insert before this rail item, or at the end when `null`. */
      before: RailItem | null;
      /** Viewport x of the insertion line, for drawing it. */
      x: number;
      /**
       * The rail's own vertical extent.
       *
       * The line is drawn `position: fixed`, so without this it runs the full
       * height of the window and strikes through the workspace header and the
       * titlebar above the rail it is dropping into.
       */
      top: number;
      bottom: number;
    }
  | { kind: 'float' };

/**
 * Every seam a panel could be inserted at, left to right.
 *
 * Adjacent slots share a seam, so consecutive `right`/`left` pairs collapse to
 * one boundary — otherwise a two-pixel gap between slots would offer two
 * targets a person cannot tell apart, and which one won would come down to
 * sub-pixel rounding.
 */
export function railBoundaries(
  slots: RailSlotRect[],
  bounds: RailBounds
): { x: number; before: RailItem | null }[] {
  if (slots.length === 0) return [{ x: bounds.left, before: null }];

  const boundaries: { x: number; before: RailItem | null }[] = [
    { x: slots[0].left, before: slots[0].item },
  ];
  for (let i = 1; i < slots.length; i += 1) {
    boundaries.push({ x: (slots[i - 1].right + slots[i].left) / 2, before: slots[i].item });
  }
  boundaries.push({ x: slots[slots.length - 1].right, before: null });
  return boundaries;
}

/**
 * The drop this pointer position means.
 *
 * Vertical position is a gate rather than a dimension: above or below the rail
 * there is no arrangement to join, so it floats regardless of how well the x
 * lines up with a seam.
 */
export function dropTargetAt(
  slots: RailSlotRect[],
  bounds: RailBounds,
  point: { x: number; y: number },
  snapPx: number = SNAP_PX
): DropTarget {
  if (point.y < bounds.top || point.y > bounds.bottom) return { kind: 'float' };

  let best: { x: number; before: RailItem | null } | null = null;
  let bestDistance = Infinity;
  for (const boundary of railBoundaries(slots, bounds)) {
    const distance = Math.abs(point.x - boundary.x);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = boundary;
    }
  }

  if (!best || bestDistance > snapPx) return { kind: 'float' };
  return {
    kind: 'dock',
    before: best.before,
    x: best.x,
    top: bounds.top,
    bottom: bounds.bottom,
  };
}

/**
 * The layout a release produces.
 *
 * Dropping onto the rail docks the panel — putting something in a row is the
 * gesture for wanting it there, and leaving it floating over the slot it just
 * claimed would be a move that visibly did nothing.
 */
export function applyDrop(
  layout: WorkspaceLayout,
  panel: PanelId,
  target: DropTarget
): WorkspaceLayout {
  if (target.kind === 'float') return setFloating(layout, panel, true);
  const to = target.before === null ? layout.order.length : layout.order.indexOf(target.before);
  return movePanel(layout, panel, to === -1 ? layout.order.length : to);
}

/**
 * A one-line description of what releasing now would do.
 *
 * Shown on the drag chip. A drag that changes where you work should say so
 * before you commit to it, and "Float" versus "Left of Preview" is the whole
 * difference between the two outcomes this gesture has.
 */
export function describeDrop(target: DropTarget, labelOf: (item: RailItem) => string): string {
  if (target.kind === 'float') return 'Float';
  if (target.before === null) return 'Far right';
  if (target.before === PREVIEW) return 'Left of preview';
  return `Before ${labelOf(target.before)}`;
}
