/**
 * DashboardHeader component for the main project list view.
 *
 * Provides:
 * - Search input with Cmd+K keyboard shortcut for quick filtering
 * - "New Folder" button to create folders
 * - "New Project" button to create projects
 * - Settings button for app configuration
 *
 * @module components/DashboardHeader
 */

import { useEffect, useRef } from 'react';
import { SearchIcon } from './icons';
import { trackEvent, trackSearch } from '../lib/analytics';
import { Button } from './primitives/Button';

interface DashboardHeaderProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onCreateProject: () => void;
  onImportProject?: () => void;
  /** Whether GitHub is authenticated (import requires GitHub) */
  isGitHubAuthenticated?: boolean;
  /** Callback when user tries to import without GitHub auth */
  onGitHubConnectForImport?: () => void;
}

export function DashboardHeader({
  searchQuery,
  onSearchChange,
  onCreateProject,
  onImportProject,
  isGitHubAuthenticated = true,
  onGitHubConnectForImport,
}: DashboardHeaderProps) {
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Cmd+K keyboard shortcut to focus search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="dashboard-header">
      <div className="dashboard-search" data-education-id="search-projects">
        <SearchIcon />
        <input
          ref={searchInputRef}
          type="text"
          placeholder="Search projects..."
          value={searchQuery}
          onChange={(e) => {
            onSearchChange(e.target.value);
            trackSearch('project_search', e.target.value, 'Dashboard');
          }}
          className="dashboard-search-input"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <span className="dashboard-search-shortcut">⌘K</span>
      </div>
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
