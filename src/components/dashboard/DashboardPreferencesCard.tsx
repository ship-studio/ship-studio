/**
 * DashboardPreferencesCard — dashboard sidebar shortcuts for settings and updates.
 *
 * @module components/DashboardPreferencesCard
 */

import { trackEvent } from '../../lib/analytics';
import { ChevronRightIcon, HistoryIcon, SettingsIcon } from '../icons';
import { Button } from '../primitives/Button';

interface DashboardPreferencesCardProps {
  onOpenSettings: () => void;
  onOpenChangelog: () => void;
}

/**
 * Renders dashboard preference shortcuts and records their click events.
 * @param props - Callbacks that open settings and changelog surfaces.
 */
export function DashboardPreferencesCard({
  onOpenSettings,
  onOpenChangelog,
}: DashboardPreferencesCardProps) {
  return (
    <section className="dashboard-card">
      <header className="dashboard-card-header">
        <div>
          <h3 className="dashboard-card-title">Preferences</h3>
          <p className="dashboard-card-subtitle">Adjust app settings or review recent updates.</p>
        </div>
      </header>
      <div className="dashboard-card-rows">
        <Button
          variant="ghost"
          className="dashboard-card-row"
          data-education-id="settings-button"
          onClick={() => {
            void trackEvent('settings_opened', { $screen_name: 'Dashboard' });
            onOpenSettings();
          }}
        >
          <div className="dashboard-card-row-icon">
            <SettingsIcon size={18} />
          </div>
          <div className="dashboard-card-row-main">
            <div className="dashboard-card-row-name">Settings</div>
            <div className="dashboard-card-row-status">
              Dashboard widgets, compact mode, learn mode
            </div>
          </div>
          <ChevronRightIcon size={14} />
        </Button>
        <Button
          variant="ghost"
          className="dashboard-card-row"
          onClick={() => {
            void trackEvent('changelog_opened', { $screen_name: 'Dashboard' });
            onOpenChangelog();
          }}
        >
          <div className="dashboard-card-row-icon">
            <HistoryIcon size={14} />
          </div>
          <div className="dashboard-card-row-main">
            <div className="dashboard-card-row-name">What's New</div>
            <div className="dashboard-card-row-status">
              Recent updates and downgrade to older versions
            </div>
          </div>
          <ChevronRightIcon size={14} />
        </Button>
      </div>
    </section>
  );
}
