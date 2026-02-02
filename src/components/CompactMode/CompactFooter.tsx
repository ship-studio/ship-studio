/**
 * Compact Mode Footer - Bottom bar with status info.
 *
 * Shows:
 * - Auto-accept mode status
 * - Resize hint
 *
 * @module components/CompactMode/CompactFooter
 */

import { ZapIcon } from '../icons';

export interface CompactFooterProps {
  /** Whether auto-accept mode is enabled */
  autoAcceptMode: boolean;
}

export function CompactFooter({ autoAcceptMode }: CompactFooterProps) {
  return (
    <div className="compact-footer">
      <div className="compact-footer-left">
        <span className={`compact-footer-status ${autoAcceptMode ? 'active' : ''}`}>
          <ZapIcon size={10} />
          <span>Auto-accept: {autoAcceptMode ? 'ON' : 'OFF'}</span>
        </span>
      </div>
      <div className="compact-footer-right">
        <span className="compact-footer-hint">Drag to resize</span>
      </div>
    </div>
  );
}
