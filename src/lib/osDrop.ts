/**
 * Helpers for routing OS file drops (Tauri `onDragDropEvent`) to the right
 * region of the UI.
 *
 * Tauri's JS API hands every drop position back as a `PhysicalPosition`, but
 * the underlying wry value is NOT in the same coordinate space on every OS:
 *
 * - macOS (wry `wkwebview/drag_drop.rs`): the position is derived from
 *   `NSView.frame` height minus `NSDraggingInfo.draggingLocation`, both of
 *   which are in LOGICAL points — i.e. it is already in CSS pixels.
 * - Windows (wry `webview2/drag_drop.rs`): the position is the client-area
 *   POINT in PHYSICAL pixels, so it must be divided by the device pixel ratio
 *   to reach CSS pixels.
 *
 * `document.elementFromPoint` wants CSS pixels. Dividing the macOS position by
 * `devicePixelRatio` (2 on a Retina display) would halve an already-correct
 * coordinate and land the hit-test in the wrong place — which silently breaks
 * any position-sensitive drop target (e.g. the code file tree). To stay correct
 * across platforms AND robust to fractional DPI / future wry changes, we build
 * an ordered list of candidate CSS points (the platform's expected conversion
 * first, the alternate second) and let callers pick whichever lands on a real
 * target.
 *
 * It also defines the `[data-os-drop-zone]` convention: any region that handles
 * its own OS drops marks itself with that attribute, and other global drop
 * listeners (e.g. the terminal's paste-on-drop) skip drops that land on such a
 * zone so a single drop isn't handled twice.
 *
 * @module lib/osDrop
 */

/** A Tauri drag position (`{ x, y }`), physical on Windows, logical on macOS. */
export interface PhysicalPosition {
  x: number;
  y: number;
}

/** True when running on macOS, where the drop position is already in CSS px. */
function isMacOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // `navigator.platform` is deprecated but reliable inside WKWebView; the UA
  // string ("Macintosh") covers it as well. Either match is enough.
  const platform = (navigator as Navigator & { platform?: string }).platform || '';
  return /Mac/i.test(ua) || /Mac/i.test(platform);
}

/**
 * Ordered CSS-pixel candidates for a wry drop position. The platform's expected
 * conversion comes first; the alternate is a fallback for scale mismatches.
 * When the device pixel ratio is 1 both conversions coincide, so we return one.
 */
export function cssCandidatesForDrop(pos: PhysicalPosition): Array<{ x: number; y: number }> {
  const dpr = window.devicePixelRatio || 1;
  const asLogical = { x: pos.x, y: pos.y };
  if (dpr === 1) return [asLogical];
  const asScaled = { x: pos.x / dpr, y: pos.y / dpr };
  return isMacOS() ? [asLogical, asScaled] : [asScaled, asLogical];
}

/**
 * The DOM element under a physical drag position. Tries each candidate point in
 * order and returns the first that resolves to an element.
 */
export function elementAtPhysical(pos: PhysicalPosition): Element | null {
  for (const c of cssCandidatesForDrop(pos)) {
    const el = document.elementFromPoint(c.x, c.y);
    if (el) return el;
  }
  return null;
}

/**
 * The nearest `[data-os-drop-zone]` ancestor under `pos`, or null. Used by
 * region owners to claim a drop, and by other global drop listeners to bow out.
 * Prefers whichever candidate point lands inside a drop zone, so a Retina-scale
 * mismatch can't cause a region to wrongly miss (or steal) a drop.
 */
export function osDropZoneAt(pos: PhysicalPosition): HTMLElement | null {
  for (const c of cssCandidatesForDrop(pos)) {
    const zone = document.elementFromPoint(c.x, c.y)?.closest<HTMLElement>('[data-os-drop-zone]');
    if (zone) return zone;
  }
  return null;
}
