/**
 * Geometry for the breakpoint canvas — the preview's every-breakpoint-at-once
 * mode, where each device width renders in its own frame side by side on one
 * scaled, scrollable surface.
 *
 * Pure math, no DOM and no React: the canvas component maps these results onto
 * elements, and the tests exercise the layout directly. Frames come in from the
 * caller (mapped from the preview's own breakpoint presets) so the widths have
 * exactly one definition.
 *
 * @module lib/previewCanvas
 */

/** One device column on the canvas. */
export interface CanvasFrame {
  /** Stable id — the preview breakpoint name (`desktop`, `mobile`, …). */
  id: string;
  /** Human label shown above the frame. */
  label: string;
  /** The CSS width the page lays out at, in unscaled canvas pixels. */
  width: number;
}

/** A frame placed on the canvas surface. */
export interface FramePlacement extends CanvasFrame {
  /** Left offset within the (unscaled) canvas surface. */
  x: number;
}

export interface CanvasLayout {
  placements: FramePlacement[];
  /** Total surface width in unscaled canvas pixels. */
  contentWidth: number;
}

/** Gutter between frames, in unscaled canvas pixels. */
export const CANVAS_GAP_PX = 48;

/** Height reserved above each frame for its label row, in canvas pixels. */
export const CANVAS_LABEL_PX = 32;

/** Outer padding around the whole surface, in canvas pixels. */
export const CANVAS_PADDING_PX = 32;

/** Zoom levels offered next to "Fit". */
export const ZOOM_STEPS = [0.5, 0.75, 1] as const;

/** How far a frame can sit outside the visible canvas and still stay mounted,
 *  as a multiple of the visible width. One screen of slack on each side keeps
 *  a slow scroll from tearing frames down and reloading them immediately. */
const MOUNT_MARGIN_SCREENS = 1;

const MIN_SCALE = 0.05;
const MIN_FRAME_HEIGHT_PX = 480;
const MAX_FRAME_HEIGHT_PX = 3200;

/**
 * Place frames left to right in the order given, separated by `gap`, with
 * `CANVAS_PADDING_PX` of surface padding on each side.
 */
export function layoutFrames(frames: CanvasFrame[], gap: number = CANVAS_GAP_PX): CanvasLayout {
  let x = CANVAS_PADDING_PX;
  const placements: FramePlacement[] = [];
  for (const frame of frames) {
    placements.push({ ...frame, x });
    x += frame.width + gap;
  }
  // The trailing gap becomes the right-hand padding; drop it and add padding
  // so an empty frame list still reports a sane (zero-content) width.
  const contentWidth = frames.length === 0 ? 0 : x - gap + CANVAS_PADDING_PX;
  return { placements, contentWidth };
}

/**
 * The scale at which the whole surface fits the visible canvas width. Never
 * scales *up* past 1 — a canvas narrower than the pane sits at true size
 * rather than being blown up past its own pixel grid.
 */
export function fitScale(contentWidth: number, viewportWidth: number): number {
  if (contentWidth <= 0 || viewportWidth <= 0) return 1;
  return Math.max(MIN_SCALE, Math.min(1, viewportWidth / contentWidth));
}

/**
 * The CSS height each frame renders at. The frames are scaled along with the
 * rest of the surface, so a small scale needs a taller frame to fill the pane:
 * a four-frame canvas fitted into a laptop pane sits near 0.3, which is why the
 * ceiling is in the low thousands rather than something that looks tidier — a
 * lower one leaves the bottom third of the canvas empty. It is a safety valve
 * against a canvas zoomed out far enough to ask for an absurd viewport, not a
 * target.
 */
export function frameHeight(viewportHeight: number, scale: number): number {
  if (viewportHeight <= 0 || scale <= 0) return MIN_FRAME_HEIGHT_PX;
  const raw = Math.round(viewportHeight / scale);
  return Math.max(MIN_FRAME_HEIGHT_PX, Math.min(MAX_FRAME_HEIGHT_PX, raw));
}

/**
 * Which frames are close enough to the visible window to stay mounted. Every
 * mounted frame is a full dev-server client with its own HMR socket, so frames
 * scrolled well out of view are torn down and replaced by a placeholder.
 *
 * `scrollLeft` and `viewportWidth` are in SCREEN pixels; placements are in
 * canvas pixels, so the window is converted by `scale` before comparing.
 */
export function visibleFrameIds(
  layout: CanvasLayout,
  scale: number,
  scrollLeft: number,
  viewportWidth: number
): string[] {
  if (scale <= 0) return layout.placements.map((placement) => placement.id);
  // An unmeasured pane (width 0) must not report "nothing is visible" — that
  // would unmount every frame on the first render, before the ResizeObserver
  // has reported a width.
  if (viewportWidth <= 0) return layout.placements.map((placement) => placement.id);

  const margin = (viewportWidth / scale) * MOUNT_MARGIN_SCREENS;
  const windowStart = scrollLeft / scale - margin;
  const windowEnd = (scrollLeft + viewportWidth) / scale + margin;

  return layout.placements
    .filter((placement) => placement.x < windowEnd && placement.x + placement.width > windowStart)
    .map((placement) => placement.id);
}

/**
 * Scroll offset (screen pixels) that centres a frame in the visible canvas,
 * clamped to the scrollable range.
 */
export function scrollToCenterFrame(
  layout: CanvasLayout,
  frameId: string,
  scale: number,
  viewportWidth: number
): number {
  const placement = layout.placements.find((candidate) => candidate.id === frameId);
  if (!placement || scale <= 0) return 0;
  const centre = (placement.x + placement.width / 2) * scale;
  const max = Math.max(0, layout.contentWidth * scale - viewportWidth);
  return Math.max(0, Math.min(max, centre - viewportWidth / 2));
}
