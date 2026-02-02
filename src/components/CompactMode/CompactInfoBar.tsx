/**
 * Compact Mode Info Bar - Header row for compact mode.
 *
 * Contains window control buttons on the right:
 * - Pin (always on top toggle)
 * - Expand (return to full mode)
 *
 * The left side is empty to accommodate macOS traffic lights.
 * Project name is shown in the window title instead.
 *
 * @module components/CompactMode/CompactInfoBar
 */

import { PinIcon, ExpandIcon } from '../icons';

export interface CompactInfoBarProps {
  /** Whether window is pinned (always on top) */
  isPinned: boolean;
  /** Callback to toggle pin state */
  onPinToggle: () => void;
  /** Callback to expand to full mode */
  onExpandToFull: () => void;
}

export function CompactInfoBar({ isPinned, onPinToggle, onExpandToFull }: CompactInfoBarProps) {
  return (
    <div className="compact-info-bar">
      {/* Left side empty - space for traffic lights */}
      <div className="compact-info-left" />

      <div className="compact-info-right">
        <button
          className={`compact-control-btn compact-control-btn-small ${isPinned ? 'active' : ''}`}
          onClick={onPinToggle}
          title={isPinned ? 'Unpin from top' : 'Pin to top'}
          aria-label={isPinned ? 'Unpin from top' : 'Pin to top'}
        >
          <PinIcon size={10} />
        </button>
        <button
          className="compact-control-btn compact-control-btn-small"
          onClick={onExpandToFull}
          title="Expand to full mode"
          aria-label="Expand to full mode"
        >
          <ExpandIcon size={10} />
        </button>
      </div>
    </div>
  );
}
