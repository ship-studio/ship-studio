/**
 * IntegrationBar — required-integrations card at the bottom of the dashboard.
 *
 * Styled as a shared .dashboard-card so it reads as part of the same stack
 * as the Coding Agents and Preferences cards. Collapsed by default — the
 * summary line ("All integrations connected" or "X/Y ready") sits inside
 * the card header, and the individual integration rows reveal on expand.
 *
 * @module components/IntegrationBar
 */

import { useState, useEffect } from 'react';
import { CheckIcon, WarningIcon, ChevronIcon, ClaudeIcon, GitHubIcon } from './icons';
import { Spinner } from './primitives/Spinner';
import { getFullSetupStatus, SetupItem, SETUP_ITEM_ORDER } from '../lib/setup';
import { logger } from '../lib/logger';

interface IntegrationBarProps {
  /** Callback to connect GitHub account */
  onGitHubConnect?: () => void;
}

export function IntegrationBar({ onGitHubConnect }: IntegrationBarProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [setupItems, setSetupItems] = useState<SetupItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      try {
        const status = await getFullSetupStatus();
        const sorted = [...status.items].sort((a, b) => {
          return SETUP_ITEM_ORDER.indexOf(a.id) - SETUP_ITEM_ORDER.indexOf(b.id);
        });
        setSetupItems(sorted);
      } catch (error) {
        logger.error('Failed to load setup status', {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setIsLoading(false);
      }
    };
    void load();
  }, []);

  const readyCount = setupItems.filter((item) => item.status === 'ready').length;
  const totalCount = setupItems.length;
  const allConnected = totalCount > 0 && readyCount === totalCount;

  const getItemIcon = (itemId: string) => {
    switch (itemId) {
      case 'claude':
      case 'claude_auth':
        return <ClaudeIcon />;
      case 'gh':
      case 'gh_auth':
        return <GitHubIcon />;
      default:
        return <CheckIcon size={16} />;
    }
  };

  const getStatusText = (item: SetupItem) => {
    if (item.status === 'ready') {
      return item.username || item.version || 'Ready';
    }
    return item.status === 'not_installed' ? 'Not installed' : 'Not connected';
  };

  const getConnectHandler = (itemId: string) => {
    if (itemId === 'gh_auth') return onGitHubConnect;
    return undefined;
  };

  const subtitle = isLoading
    ? 'Checking…'
    : allConnected
      ? 'All integrations connected'
      : `${readyCount}/${totalCount} ready`;

  const statusIcon = isLoading ? (
    <Spinner size="sm" />
  ) : allConnected ? (
    <CheckIcon size={14} className="integration-bar-status-icon success" />
  ) : (
    <WarningIcon size={14} className="integration-bar-status-icon warning" />
  );

  return (
    <section
      className={`dashboard-card integration-bar ${isExpanded ? 'is-expanded' : ''}`}
      data-education-id="integration-bar"
    >
      <button
        type="button"
        className="dashboard-card-header integration-bar-header-btn"
        onClick={() => setIsExpanded((v) => !v)}
        aria-expanded={isExpanded}
      >
        <div>
          <h3 className="dashboard-card-title">Integrations</h3>
          <p className="dashboard-card-subtitle integration-bar-subtitle">
            {statusIcon}
            <span>{subtitle}</span>
          </p>
        </div>
        <ChevronIcon
          size={14}
          className={`integration-bar-chevron ${isExpanded ? 'up' : 'down'}`}
        />
      </button>

      {isExpanded && (
        <div className="dashboard-card-rows">
          {setupItems.map((item) => {
            const connectHandler = getConnectHandler(item.id);
            const showConnectButton = item.status !== 'ready' && connectHandler;
            const isReady = item.status === 'ready';

            return (
              <div key={item.id} className="dashboard-card-row is-static">
                <div className={`dashboard-card-row-icon ${isReady ? 'success' : ''}`}>
                  {getItemIcon(item.id)}
                </div>
                <div className="dashboard-card-row-main">
                  <span className="dashboard-card-row-name">{item.friendlyName}</span>
                  <span className={`dashboard-card-row-status ${isReady ? 'success' : ''}`}>
                    {getStatusText(item)}
                  </span>
                </div>
                {showConnectButton && (
                  <button
                    className="integration-bar-item-connect"
                    onClick={(e) => {
                      e.stopPropagation();
                      connectHandler();
                    }}
                  >
                    Connect
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
