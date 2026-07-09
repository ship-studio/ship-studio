/**
 * Pure geometry helpers for routing window-global Tauri `drag-drop` events
 * to the pane under the cursor.
 *
 * Tauri's `tauri://drag-drop` event is window-global, and every mounted
 * Terminal registers a listener — including hidden tabs and background
 * projects, which stay mounted (`visibility: hidden`) so their PTYs keep
 * running. Each instance must therefore decide from the drop position
 * whether the drop belongs to it, or a single drop fans out to every
 * agent's PTY (issue #167).
 *
 * The payload's `position` is *typed* as a Tauri `PhysicalPosition`, but
 * what wry actually delivers is platform-dependent:
 *   - Windows: true device pixels (`ScreenToClient` on the raw screen point)
 *   - macOS: AppKit points — ALREADY logical CSS pixels, passed through
 *     unscaled (wry `wkwebview/drag_drop.rs` uses `draggingLocation()` with
 *     no scale-factor conversion; tauri-runtime-wry wraps the tuple verbatim)
 *   - GTK/Linux: logical, like macOS
 * Dividing by devicePixelRatio on macOS therefore lands every Retina drop at
 * half-coordinates, the hit-test misses, and drops are silently ignored —
 * use {@link dropPointToLogical}, which only converts where conversion is due.
 */

/** An x/y point. Physical or logical depending on context. */
export interface DropPoint {
  x: number;
  y: number;
}

/** The subset of `DOMRect` needed for hit-testing (keeps tests DOM-free). */
export interface DropRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Convert a physical (device-pixel) drop position to logical CSS pixels.
 * A non-positive or non-finite ratio (headless webviews, defensive) is
 * treated as 1.
 */
export function physicalToLogical(position: DropPoint, devicePixelRatio: number): DropPoint {
  const scale = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return { x: position.x / scale, y: position.y / scale };
}

/**
 * Normalize a Tauri drag-drop position to logical CSS pixels for rect
 * hit-testing. Only Windows delivers true device pixels; macOS (and GTK)
 * deliver logical coordinates despite the `PhysicalPosition` typing — see
 * the module docs. Scaling those breaks every drop on a Retina display.
 */
export function dropPointToLogical(
  position: DropPoint,
  isWindowsPlatform: boolean,
  devicePixelRatio: number
): DropPoint {
  return isWindowsPlatform ? physicalToLogical(position, devicePixelRatio) : position;
}

/**
 * True when `point` (logical px) falls inside `rect`. Zero- and
 * negative-area rects — what hidden or `display: none` elements report —
 * never match.
 */
export function isPointInRect(point: DropPoint, rect: DropRect): boolean {
  if (rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0) return false;
  return (
    point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom
  );
}
