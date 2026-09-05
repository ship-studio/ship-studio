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

/** One device artboard on the canvas. */
export interface CanvasFrame {
  /** Stable id — the preview breakpoint name (`desktop`, `mobile`, …). */
  id: string;
  /** Human label shown above the frame. */
  label: string;
  /** The CSS width the page lays out at, in unscaled canvas pixels. */
  width: number;
  /** The CSS height the page lays out at. A frame's height IS the viewport it
   *  reports, so this has to be a plausible device height: a `100vh` hero is
   *  exactly as tall as this number says it is. */
  height: number;
}

/**
 * Viewport heights to go with the preview's device widths. Ordinary screens,
 * not the pane's dimensions — a frame sized from the pane would make every
 * viewport-relative unit in the page a lie.
 */
export const DEVICE_HEIGHTS: Record<string, number> = {
  desktop: 900,
  laptop: 700,
  tablet: 1024,
  mobile: 812,
};

/** Height for a device the table doesn't name — a normal laptop screen. */
export const DEFAULT_DEVICE_HEIGHT = 800;

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

/** Breathing room between the outermost frames and the pane at Fit, in screen
 *  pixels. */
export const CANVAS_PADDING_PX = 32;

/** How far past the content the canvas can be pushed, as a fraction of the
 *  visible canvas. Without it the frames are pinned to the scroll extents and
 *  the canvas feels stuck — a design canvas lets you shove the artwork around. */
export const PAN_SLACK_RATIO = 0.5;

/** Zoom bounds. Below the floor the frames stop being readable at all; above
 *  the ceiling a preview frame is magnified past any useful detail. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 2;

/** One press of the zoom buttons, as a ratio — multiplicative so a step feels
 *  the same size at 20% as at 150%. */
const ZOOM_STEP_RATIO = 1.25;

/** Above this, a wheel event is a discrete mouse-wheel notch rather than a
 *  trackpad gesture. The two arrive as the same event with wildly different
 *  magnitudes — a notch is ~100+ at once, a pinch is a stream of small deltas —
 *  and treating a notch as continuous makes a mouse wheel fly, while treating a
 *  pinch as a notch makes the trackpad crawl. */
const COARSE_WHEEL_DELTA = 50;

/** Continuous zoom response, per pixel of trackpad movement. Tuned so a normal
 *  pinch travels roughly the distance the fingers do — a gesture should feel
 *  like dragging the canvas closer, not like a nudge or a jump. */
const PINCH_RESPONSE = 0.006;

/** How far a frame can sit outside the visible canvas and still stay mounted,
 *  as a multiple of the visible width. One screen of slack on each side keeps
 *  a slow scroll from tearing frames down and reloading them immediately. */
const MOUNT_MARGIN_SCREENS = 1;

const MIN_SCALE = 0.05;

/**
 * Place frames left to right in the order given, separated by `gap`, with
 * `CANVAS_PADDING_PX` of surface padding on each side.
 */
export function layoutFrames(frames: CanvasFrame[], gap: number = CANVAS_GAP_PX): CanvasLayout {
  let x = 0;
  const placements: FramePlacement[] = [];
  for (const frame of frames) {
    placements.push({ ...frame, x });
    x += frame.width + gap;
  }
  // Frames and the gaps between them, nothing else: the room AROUND the frames
  // is screen-space slack the component adds, not part of what has to fit.
  const contentWidth = frames.length === 0 ? 0 : x - gap;
  return { placements, contentWidth };
}

/**
 * The scale at which the whole surface fits the visible canvas width. Never
 * scales *up* past 1 — a canvas narrower than the pane sits at true size
 * rather than being blown up past its own pixel grid.
 */
export function fitScale(contentWidth: number, viewportWidth: number): number {
  if (contentWidth <= 0 || viewportWidth <= 0) return 1;
  const usable = Math.max(1, viewportWidth - CANVAS_PADDING_PX * 2);
  return Math.max(MIN_SCALE, Math.min(1, usable / contentWidth));
}

/** The tallest frame on the canvas — the surface has to hold it. */
export function tallestFrame(layout: CanvasLayout): number {
  return layout.placements.reduce((tallest, frame) => Math.max(tallest, frame.height), 0);
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
  viewportWidth: number,
  /** Screen-space offset of the frames within the scrollable surface. */
  originX = 0
): string[] {
  if (scale <= 0) return layout.placements.map((placement) => placement.id);
  // An unmeasured pane (width 0) must not report "nothing is visible" — that
  // would unmount every frame on the first render, before the ResizeObserver
  // has reported a width.
  if (viewportWidth <= 0) return layout.placements.map((placement) => placement.id);

  const margin = (viewportWidth / scale) * MOUNT_MARGIN_SCREENS;
  const windowStart = (scrollLeft - originX) / scale - margin;
  const windowEnd = (scrollLeft - originX + viewportWidth) / scale + margin;

  return layout.placements
    .filter((placement) => placement.x < windowEnd && placement.x + placement.width > windowStart)
    .map((placement) => placement.id);
}

/** Hold a zoom level inside the usable range. */
export function clampZoom(zoom: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

/** The next zoom level in or out, one button press from `zoom`. */
export function stepZoom(zoom: number, direction: 'in' | 'out'): number {
  return clampZoom(direction === 'in' ? zoom * ZOOM_STEP_RATIO : zoom / ZOOM_STEP_RATIO);
}

/**
 * The zoom a wheel gesture asks for. A trackpad pinch is continuous and
 * proportional to the gesture; a mouse-wheel notch is one discrete step,
 * whatever number of pixels the OS attaches to it.
 */
export function wheelZoom(zoom: number, deltaY: number): number {
  if (deltaY === 0) return zoom;
  if (Math.abs(deltaY) >= COARSE_WHEEL_DELTA) {
    return stepZoom(zoom, deltaY < 0 ? 'in' : 'out');
  }
  return clampZoom(zoom * Math.exp(-deltaY * PINCH_RESPONSE));
}

/**
 * Scroll offsets that keep the canvas point under the pointer under the pointer
 * across a zoom change — the difference between zooming *at the cursor* and
 * zooming at the top-left corner, which throws the user's place away.
 *
 * `pointerX`/`pointerY` are relative to the visible canvas box.
 */
export function anchorScroll(params: {
  scrollLeft: number;
  scrollTop: number;
  pointerX: number;
  pointerY: number;
  fromScale: number;
  toScale: number;
  /** Where the frames start inside the surface (the pan slack). Constant across
   *  a zoom, but it offsets every screen position, so leaving it out anchors
   *  the zoom on the wrong point and the canvas drifts under the pointer. */
  originX?: number;
  originY?: number;
}): { scrollLeft: number; scrollTop: number } {
  const {
    scrollLeft,
    scrollTop,
    pointerX,
    pointerY,
    fromScale,
    toScale,
    originX = 0,
    originY = 0,
  } = params;
  if (fromScale <= 0 || toScale <= 0) return { scrollLeft, scrollTop };
  // The canvas-space point currently under the pointer, put back under it.
  const canvasX = (scrollLeft + pointerX - originX) / fromScale;
  const canvasY = (scrollTop + pointerY - originY) / fromScale;
  return {
    scrollLeft: Math.max(0, originX + canvasX * toScale - pointerX),
    scrollTop: Math.max(0, originY + canvasY * toScale - pointerY),
  };
}

/**
 * The zoom that shows one frame at its own size — or as close as the pane
 * allows. Never magnifies past true size: a preview is worth most at 1:1.
 */
export function zoomForFrame(frameWidth: number, viewportWidth: number): number {
  if (frameWidth <= 0 || viewportWidth <= 0) return 1;
  const usable = Math.max(1, viewportWidth - CANVAS_PADDING_PX * 2);
  return clampZoom(Math.min(1, usable / frameWidth));
}

/**
 * Scroll offset (screen pixels) that centres a frame in the visible canvas,
 * clamped to the scrollable range.
 */
export function scrollToCenterFrame(
  layout: CanvasLayout,
  frameId: string,
  scale: number,
  viewportWidth: number,
  /** Screen-space offset of the frames within the scrollable surface. */
  originX = 0
): number {
  const placement = layout.placements.find((candidate) => candidate.id === frameId);
  if (!placement || scale <= 0) return 0;
  const centre = originX + (placement.x + placement.width / 2) * scale;
  const max = Math.max(0, originX * 2 + layout.contentWidth * scale - viewportWidth);
  return Math.max(0, Math.min(max, centre - viewportWidth / 2));
}
