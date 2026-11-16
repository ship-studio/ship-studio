/** Geometry for the temporary topbar Focus split. */

export const DEFAULT_FOCUS_SPLIT_RATIO = 0.5;
/** Matches the Agent panel's minimum and gives Preview a useful starting width. */
export const FOCUS_SPLIT_MIN_PANE_WIDTH = 260;

export interface FocusSplitBounds {
  minWidth: number;
  maxWidth: number;
}

/** Keep both Focus panes at least 260px wide when the rail allows it. */
export function focusSplitBounds(railWidth: number): FocusSplitBounds {
  const availableWidth = Number.isFinite(railWidth) ? Math.max(0, railWidth) : 0;
  const paneMinimum = Math.min(FOCUS_SPLIT_MIN_PANE_WIDTH, Math.floor(availableWidth / 2));
  return {
    minWidth: paneMinimum,
    maxWidth: Math.max(paneMinimum, Math.floor(availableWidth - paneMinimum)),
  };
}

/** Resolve a saved ratio to pixels without changing the saved preference. */
export function focusSplitWidth(railWidth: number, ratio: number): number {
  if (!Number.isFinite(railWidth) || railWidth <= 0) return 0;
  const bounds = focusSplitBounds(railWidth);
  const validRatio =
    Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : DEFAULT_FOCUS_SPLIT_RATIO;
  return Math.round(Math.max(bounds.minWidth, Math.min(railWidth * validRatio, bounds.maxWidth)));
}

/** Convert an explicit user resize to the project preference's normalized ratio. */
export function focusSplitRatio(width: number, railWidth: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(railWidth) || railWidth <= 0) {
    return DEFAULT_FOCUS_SPLIT_RATIO;
  }
  return Math.max(0, Math.min(1, width / railWidth));
}
