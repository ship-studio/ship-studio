/**
 * MachineToolsPanel — machine-tier tools card on the dashboard.
 *
 * The other half of the integration split (see {@link AgentsPanel}, the
 * workspace-tier "Workspace accounts" card). This card lists only the tools
 * that are installed **once on the machine and shared by every workspace** —
 * Homebrew, Node, Git, and the CLI binaries — so the user can tell at a glance
 * what's "global" versus what's a per-client login. It's purely informational:
 * installing/updating these tools is owned by onboarding and, for the agent
 * CLIs, the per-agent Install button in {@link AgentsPanel}.
 *
 * Styled as a shared .dashboard-card so it reads as part of the same stack as
 * the Workspace accounts and Preferences cards. Collapsed by default.
 *
 * @module components/dashboard/MachineToolsPanel
 */

import { useState, useEffect } from 'react';
import { CheckIcon, WarningIcon, ChevronIcon, ClaudeIcon, GitHubIcon } from '../icons';
import { Spinner } from '../primitives/Spinner';
import { getFullSetupStatus, SetupItem, SETUP_ITEM_ORDER, MACHINE_ITEM_IDS } from '../../lib/setup';
import { logger } from '../../lib/logger';

export function MachineToolsPanel() {
  const [isExpanded, setIsExpanded] = useState(false);
  const [setupItems, setSetupItems] = useState<SetupItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      try {
        const status = await getFullSetupStatus();
        const machineItems = status.items
          .filter((item) => MACHINE_ITEM_IDS.has(item.id))
          .sort((a, b) => SETUP_ITEM_ORDER.indexOf(a.id) - SETUP_ITEM_ORDER.indexOf(b.id));
        setSetupItems(machineItems);
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
  const allInstalled = totalCount > 0 && readyCount === totalCount;

  const getItemIcon = (itemId: string) => {
    switch (itemId) {
      case 'claude':
        return <ClaudeIcon />;
      case 'gh':
        return <GitHubIcon />;
      default:
        return <CheckIcon size={16} />;
    }
  };

  // Machine tools have no login — "ready" means installed, otherwise it's just
  // not installed yet (the version string doubles as the installed indicator).
  const getStatusText = (item: SetupItem) => {
    if (item.status === 'ready') {
      return item.version || 'Installed';
    }
    return 'Not installed';
  };

  const subtitle = isLoading
    ? 'Checking…'
    : allInstalled
      ? 'All tools installed'
      : `${readyCount}/${totalCount} installed`;

  const statusIcon = isLoading ? (
    <Spinner size="sm" />
  ) : allInstalled ? (
    <CheckIcon size={14} className="integration-bar-status-icon success" />
  ) : (
    <WarningIcon size={14} className="integration-bar-status-icon warning" />
  );

  return (
    <section
      className={`dashboard-card integration-bar ${isExpanded ? 'is-expanded' : ''}`}
      data-education-id="machine-tools"
    >
      <button
        type="button"
        className="dashboard-card-header integration-bar-header-btn"
        onClick={() => setIsExpanded((v) => !v)}
        aria-expanded={isExpanded}
      >
        <div>
          <h3 className="dashboard-card-title">Tools on this Mac</h3>
          <p className="dashboard-card-subtitle integration-bar-subtitle">
            {statusIcon}
            <span>{subtitle}</span>
            <span className="machine-tools-shared-hint">
              · installed once, shared by every workspace
            </span>
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
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
