/**
 * DashboardPreferencesCard — dashboard sidebar shortcuts for settings and updates.
 *
 * @module components/DashboardPreferencesCard
 */

import { trackEvent } from '../../lib/analytics';
import { HistoryIcon, SettingsIcon } from '@/components/icons';
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
          <h3 className="dashboard-card-title text-style-h4">Preferences</h3>
          <p className="dashboard-card-subtitle text-style-body-medium">
            Adjust app settings or review recent updates.
          </p>
        </div>
      </header>
      <div className="dashboard-card-rows">
        <Button
          variant="default"
          size="default"
          width="hug"
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
            <div className="dashboard-card-row-name text-style-body-medium">Settings</div>
            <div className="dashboard-card-row-status text-style-control">
              Dashboard widgets, compact mode, learn mode
            </div>
          </div>
        </Button>
        <Button
          variant="default"
          size="default"
          width="hug"
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
            <div className="dashboard-card-row-name text-style-body-medium">What's New</div>
            <div className="dashboard-card-row-status text-style-control">
              Recent updates and downgrade to older versions
            </div>
          </div>
        </Button>
      </div>
    </section>
  );
}
