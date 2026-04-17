/**
 * CompactModeToggle — pin-to-top and expand-to-full buttons shown in the
 * terminal tabs bar when the window is narrow enough for compact mode.
 * Visibility is controlled via CSS (.compact-mode-controls).
 *
 * @module components/workspace/CompactModeToggle
 */

import { PinIcon, ExpandIcon } from '../icons';

export interface CompactModeToggleProps {
  isPinned: boolean;
  onPinToggle: () => Promise<void>;
  onExpandToFull: () => Promise<void>;
}

export function CompactModeToggle({
  isPinned,
  onPinToggle,
  onExpandToFull,
}: CompactModeToggleProps) {
  return (
    <div className="compact-mode-controls">
      <button
        className={`compact-control-btn ${isPinned ? 'active' : ''}`}
        onClick={() => void onPinToggle()}
        title={isPinned ? 'Unpin from top' : 'Pin to top'}
      >
        <PinIcon size={12} />
      </button>
      <button
        className="compact-control-btn"
        onClick={() => void onExpandToFull()}
        title="Expand to full mode"
      >
        <ExpandIcon size={12} />
      </button>
    </div>
  );
}
