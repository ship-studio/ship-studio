/**
 * DashboardHeader component for the main project list view.
 *
 * The search field is a button-styled trigger that opens the command palette;
 * typing happens inside the palette, not here.
 *
 * @module components/DashboardHeader
 */

import { SearchIcon } from '../icons';
import { trackEvent } from '../../lib/analytics';
import { Button } from '../primitives/Button';
import { useModal } from '../../contexts/ModalContext';

interface DashboardHeaderProps {
  onCreateProject: () => void;
  onImportProject?: () => void;
  /** Whether GitHub is authenticated (import requires GitHub) */
  isGitHubAuthenticated?: boolean;
  /** Callback when user tries to import without GitHub auth */
  onGitHubConnectForImport?: () => void;
}

export function DashboardHeader({
  onCreateProject,
  onImportProject,
  isGitHubAuthenticated = true,
  onGitHubConnectForImport,
}: DashboardHeaderProps) {
  const palette = useModal('commandPalette');

  return (
    <div className="dashboard-header">
      <button
        type="button"
        className="dashboard-search"
        data-education-id="search-projects"
        onClick={() => palette.open()}
        title="Open command palette"
        aria-label="Open command palette"
      >
        <SearchIcon />
        <span className="dashboard-search-placeholder">Search projects, actions, settings…</span>
        <span className="dashboard-search-shortcut">⌘K</span>
      </button>
      <div className="dashboard-header-actions">
        {onImportProject && (
          <Button
            variant="secondary"
            data-education-id="import-button"
            onClick={() => {
              void trackEvent('import_button_clicked', { $screen_name: 'Dashboard' });
              if (isGitHubAuthenticated) {
                onImportProject();
              } else if (onGitHubConnectForImport) {
                onGitHubConnectForImport();
              }
            }}
            title={!isGitHubAuthenticated ? 'Connect GitHub to import repositories' : undefined}
          >
            Import
          </Button>
        )}
        <Button
          variant="primary"
          data-education-id="new-project-button"
          onClick={() => {
            void trackEvent('new_project_clicked', { $screen_name: 'Dashboard' });
            onCreateProject();
          }}
        >
          + New Project
        </Button>
      </div>
    </div>
  );
}
