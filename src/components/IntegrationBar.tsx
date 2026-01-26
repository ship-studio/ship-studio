/**
 * IntegrationBar component that displays the status of required integrations.
 *
 * Shows a collapsible bar at the bottom of the dashboard indicating:
 * - Overall integration health (all connected vs some missing)
 * - Individual status of each integration (Claude, GitHub, Vercel)
 * - Whether CLI tools are installed and authenticated
 *
 * The bar is collapsed by default showing just a summary, and expands
 * to show detailed status for each integration when clicked.
 *
 * @module components/IntegrationBar
 */

import { useState, useEffect } from 'react';
import {
  CheckIcon,
  WarningIcon,
  ChevronIcon,
  ClaudeIcon,
  GitHubIcon,
  VercelIcon,
  SpinnerIcon,
} from './icons';
import { getFullSetupStatus, SetupItem, SETUP_ITEM_ORDER } from '../lib/setup';

export function IntegrationBar() {
  const [isExpanded, setIsExpanded] = useState(false);
  const [setupItems, setSetupItems] = useState<SetupItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch full setup status on mount
  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      try {
        const status = await getFullSetupStatus();
        // Sort by display order
        const sorted = [...status.items].sort((a, b) => {
          return SETUP_ITEM_ORDER.indexOf(a.id) - SETUP_ITEM_ORDER.indexOf(b.id);
        });
        setSetupItems(sorted);
      } catch (error) {
        console.error(error);
      } finally {
        setIsLoading(false);
      }
    };
    void load();
  }, []);

  const readyCount = setupItems.filter((item) => item.status === 'ready').length;
  const totalCount = setupItems.length;
  const allConnected = totalCount > 0 && readyCount === totalCount;

  // Get icon for item
  const getItemIcon = (itemId: string) => {
    switch (itemId) {
      case 'claude':
      case 'claude_auth':
        return <ClaudeIcon />;
      case 'gh':
      case 'gh_auth':
        return <GitHubIcon />;
      case 'vercel':
      case 'vercel_auth':
        return <VercelIcon size={16} />;
      default:
        return <CheckIcon size={16} />;
    }
  };

  // Get status text for item
  const getStatusText = (item: SetupItem) => {
    if (item.status === 'ready') {
      return item.username || item.version || 'Ready';
    }
    return item.status === 'not_installed' ? 'Not installed' : 'Not connected';
  };

  return (
    <div className={`integration-bar ${isExpanded ? 'expanded' : ''}`}>
      <button className="integration-bar-toggle" onClick={() => setIsExpanded(!isExpanded)}>
        {isLoading ? (
          <>
            <SpinnerIcon size={16} className="spinner-icon integration-bar-icon" />
            <span>Checking integrations...</span>
          </>
        ) : allConnected ? (
          <>
            <CheckIcon size={16} className="integration-bar-icon success" />
            <span>All integrations connected</span>
          </>
        ) : (
          <>
            <WarningIcon size={16} className="integration-bar-icon warning" />
            <span>
              {readyCount}/{totalCount} integrations ready
            </span>
          </>
        )}
        <ChevronIcon
          size={16}
          className={`integration-bar-chevron ${isExpanded ? 'up' : 'down'}`}
        />
      </button>

      {isExpanded && (
        <div className="integration-bar-content">
          {setupItems.map((item) => (
            <div
              key={item.id}
              className={`integration-bar-item ${item.status === 'ready' ? 'connected' : ''}`}
            >
              <div className="integration-bar-item-icon">{getItemIcon(item.id)}</div>
              <div className="integration-bar-item-info">
                <span className="integration-bar-item-name">{item.friendlyName}</span>
                <span
                  className={`integration-bar-item-status ${item.status === 'ready' ? 'success' : ''}`}
                >
                  {getStatusText(item)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
