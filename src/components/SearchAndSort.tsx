/**
 * SearchAndSort — section header with title, sort dropdown, and new-folder
 * button. The search input itself lives in DashboardHeader; this component
 * handles the sort/section controls row beneath it.
 *
 * @module components/SearchAndSort
 */

import { useCallback, useRef } from 'react';
import { Button } from './primitives/Button';
import { ChevronIcon, CheckIcon, FolderPlusIcon } from './icons';
import { useClickOutside } from '../hooks/useClickOutside';
import { trackEvent } from '../lib/analytics';

export type SortOption = 'last_opened' | 'name';

const SORT_LABELS: Record<SortOption, string> = {
  last_opened: 'Last opened',
  name: 'Name',
};

export interface SearchAndSortProps {
  title: string;
  totalCount: number;
  sortBy: SortOption;
  onSortChange: (option: SortOption) => void;
  showSortDropdown: boolean;
  onToggleSortDropdown: (show: boolean) => void;
  onNewFolder: () => void;
}

export function SearchAndSort({
  title,
  totalCount,
  sortBy,
  onSortChange,
  showSortDropdown,
  onToggleSortDropdown,
  onNewFolder,
}: SearchAndSortProps) {
  const sortDropdownRef = useRef<HTMLDivElement>(null);
  const closeSortDropdown = useCallback(() => onToggleSortDropdown(false), [onToggleSortDropdown]);
  useClickOutside(sortDropdownRef, closeSortDropdown, showSortDropdown);

  return (
    <div className="dashboard-section-header">
      <span className="dashboard-section-title">
        {title} {totalCount > 0 && `(${totalCount})`}
      </span>
      <div className="dashboard-section-controls">
        <div className="sort-dropdown" ref={sortDropdownRef} data-education-id="sort-projects">
          <button
            className="sort-dropdown-btn"
            onClick={() => onToggleSortDropdown(!showSortDropdown)}
          >
            {SORT_LABELS[sortBy]}
            <ChevronIcon />
          </button>
          {showSortDropdown && (
            <div className="sort-dropdown-menu">
              {(Object.keys(SORT_LABELS) as SortOption[]).map((option) => (
                <button
                  key={option}
                  className={`sort-dropdown-item ${sortBy === option ? 'active' : ''}`}
                  onClick={() => {
                    onSortChange(option);
                    onToggleSortDropdown(false);
                  }}
                >
                  {SORT_LABELS[option]}
                  {sortBy === option && <CheckIcon />}
                </button>
              ))}
            </div>
          )}
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="new-folder-btn"
          data-education-id="new-folder-button"
          onClick={() => {
            void trackEvent('new_folder_clicked', { $screen_name: 'Dashboard' });
            onNewFolder();
          }}
          title="New Folder"
          aria-label="New Folder"
        >
          <FolderPlusIcon size={14} />
        </Button>
      </div>
    </div>
  );
}
