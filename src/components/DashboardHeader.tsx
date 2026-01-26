/**
 * DashboardHeader component for the main project list view.
 *
 * Provides:
 * - Search input with Cmd+K keyboard shortcut for quick filtering
 * - "New Project" button to create projects
 * - Settings button for app configuration
 *
 * @module components/DashboardHeader
 */

import { useEffect, useRef } from 'react';
import { SearchIcon, SettingsIcon } from './icons';

interface DashboardHeaderProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onCreateProject: () => void;
  onImportProject?: () => void;
  onOpenSettings?: () => void;
}

export function DashboardHeader({
  searchQuery,
  onSearchChange,
  onCreateProject,
  onImportProject,
  onOpenSettings,
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
      <div className="dashboard-search">
        <SearchIcon />
        <input
          ref={searchInputRef}
          type="text"
          placeholder="Search projects..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
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
          <button className="btn-secondary" onClick={onImportProject}>
            Import
          </button>
        )}
        <button className="btn-primary" onClick={onCreateProject}>
          + New Project
        </button>
        {onOpenSettings && (
          <button className="dashboard-settings-btn" onClick={onOpenSettings} title="Settings">
            <SettingsIcon />
          </button>
        )}
      </div>
    </div>
  );
}
