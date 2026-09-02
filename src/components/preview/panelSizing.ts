/** Minimum width shared by docked preview side panels and the Agent panel. */
export const TREE_PANEL_MIN_WIDTH_PX = 180;

/**
 * Widest a docked preview side panel may be for a given container width.
 *
 * The canvas column the panel leaves behind also carries the preview toolbar,
 * so a panel that keeps a width the container can no longer afford doesn't
 * just crop the canvas — it squeezes the toolbar until its controls collide.
 * `reserve` is the slice of the container that always stays with the canvas.
 *
 * Never returns less than `min`: below that the panel is unusable, and the
 * honest answer at that size is to widen the pane or unpin the panel.
 */
export function maxDockedPanelWidth(
  containerWidth: number,
  min: number,
  max: number,
  reserve: number
): number {
  return Math.max(min, Math.min(max, containerWidth - reserve));
}
