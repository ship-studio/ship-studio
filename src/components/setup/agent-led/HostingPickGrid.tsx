/**
 * Hosting choice after the agent is picked: Vercel or Cloudflare becomes the
 * workspace's default host (new projects publish there), and the guided
 * prompt tells the agent to install + sign in to that provider's CLI. The
 * third card skips it — hosting can always be connected later from the
 * dashboard.
 */

import { SetupItem } from '../../../lib/setup';
import { HostChoice } from '../../../lib/agentOnboarding';
import { CloudflareIcon, HistoryIcon, VercelIcon } from '../../icons';

interface HostingPickGridProps {
  items: SetupItem[];
  onSelect: (host: HostChoice) => void;
  onSkip: () => void;
  disabled?: boolean;
}

export function HostingPickGrid({ items, onSelect, onSkip, disabled }: HostingPickGridProps) {
  // Vercel state is real backend data; Cloudflare has no detection yet, so
  // its card never claims a state (Never Assume Data).
  const vercelReady =
    items.find((i) => i.id === 'vercel')?.status === 'ready' &&
    items.find((i) => i.id === 'vercel_auth')?.status === 'ready';

  return (
    <div className="agent-pick-grid" role="list">
      <button
        type="button"
        role="listitem"
        className={`agent-pick-card ${vercelReady ? 'detected-ready' : ''}`}
        onClick={() => onSelect('vercel')}
        disabled={disabled}
      >
        <span className="agent-pick-card-icon">
          <VercelIcon size={26} />
        </span>
        <span className="agent-pick-card-name">Vercel</span>
        <span className="agent-pick-card-desc">Fast global hosting with free SSL</span>
        {vercelReady && <span className="agent-pick-card-status ready">✓ Ready</span>}
      </button>
      <button
        type="button"
        role="listitem"
        className="agent-pick-card"
        onClick={() => onSelect('cloudflare')}
        disabled={disabled}
      >
        <span className="agent-pick-card-icon">
          <CloudflareIcon size={30} />
        </span>
        <span className="agent-pick-card-name">Cloudflare</span>
        <span className="agent-pick-card-desc">Pages hosting on Cloudflare's edge</span>
      </button>
      <button
        type="button"
        role="listitem"
        className="agent-pick-card agent-pick-card-muted"
        onClick={onSkip}
        disabled={disabled}
      >
        <span className="agent-pick-card-icon">
          <HistoryIcon size={26} />
        </span>
        <span className="agent-pick-card-name">Skip for now</span>
        <span className="agent-pick-card-desc">You can connect hosting anytime later</span>
      </button>
    </div>
  );
}
