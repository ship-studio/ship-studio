/**
 * Overlay component displayed when a feature requires GitHub authentication.
 *
 * Shows a full-tab overlay with service icon, title, description, and connect button.
 *
 * @module components/ConnectOverlay
 */

import { GitHubIcon } from '@/components/icons';
import { Button } from './primitives/Button';

interface ConnectOverlayProps {
  /** Title text explaining what connection enables */
  title: string;
  /** Description text with more details */
  description: string;
  /** Called when user clicks the Connect button */
  onConnect: () => void;
  /** Whether connect action is in progress */
  isConnecting?: boolean;
}

export function ConnectOverlay({
  title,
  description,
  onConnect,
  isConnecting,
}: ConnectOverlayProps) {
  return (
    <div className="connect-overlay">
      <div className="connect-overlay-content">
        <div className="connect-overlay-icon">
          <GitHubIcon size={48} />
        </div>
        <h3 className="connect-overlay-title">{title}</h3>
        <p className="connect-overlay-description">{description}</p>
        <Button variant="primary" onClick={onConnect} disabled={isConnecting}>
          {isConnecting ? 'Connecting...' : 'Connect GitHub'}
        </Button>
      </div>
    </div>
  );
}
