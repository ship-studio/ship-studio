/**
 * SearchAndSort — section header with title, sort dropdown, and new-folder
 * button. The search input itself lives in DashboardHeader; this component
 * handles the sort/section controls row beneath it.
 *
 * @module components/SearchAndSort
 */

import { Button } from '../primitives/Button';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { ChevronIcon, CheckIcon, FolderPlusIcon, GridIcon, ListIcon } from '../icons';
import { trackEvent } from '../../lib/analytics';
import type { ProjectViewMode } from './ProjectGridView';

/** Dashboard project sort keys. */
export type SortOption = 'last_opened' | 'name';

const SORT_LABELS: Record<SortOption, string> = {
  last_opened: 'Last opened',
  name: 'Name',
};

/** Props for the dashboard section controls row. */
export interface SearchAndSortProps {
  title: string;
  totalCount: number;
  sortBy: SortOption;
  viewMode: ProjectViewMode;
  onSortChange: (option: SortOption) => void;
  onViewModeChange: (mode: ProjectViewMode) => void;
  onNewFolder: () => void;
  /** Optional element rendered just after the title (e.g. a workspace chip). */
  titleAccessory?: React.ReactNode;
}

/**
 * Renders dashboard sort, view-mode, and folder creation controls.
 * @param props - Section label, active controls, and action callbacks.
 */
export function SearchAndSort({
  title,
  totalCount,
  sortBy,
  viewMode,
  onSortChange,
  onViewModeChange,
  onNewFolder,
  titleAccessory,
}: SearchAndSortProps) {
  return (
    <div className="dashboard-section-header">
      <div className="dashboard-section-heading">
        <span className="dashboard-section-title">
          {title} {totalCount > 0 && `(${totalCount})`}
        </span>
        {titleAccessory}
      </div>
      <div className="dashboard-section-controls">
        <div className="dashboard-view-toggle" role="group" aria-label="Project view">
          <Button
            variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
            size="sm"
            className="dashboard-view-toggle-btn"
            aria-pressed={viewMode === 'grid'}
            aria-label="Grid view"
            title="Grid view"
            onClick={() => onViewModeChange('grid')}
          >
            <GridIcon size={14} />
            <span className="dashboard-view-toggle-label">Grid</span>
          </Button>
          <Button
            variant={viewMode === 'list' ? 'secondary' : 'ghost'}
            size="sm"
            className="dashboard-view-toggle-btn"
            aria-pressed={viewMode === 'list'}
            aria-label="List view"
            title="List view"
            onClick={() => onViewModeChange('list')}
          >
            <ListIcon size={14} />
            <span className="dashboard-view-toggle-label">List</span>
          </Button>
        </div>
        <Dropdown
          align="right"
          menuClassName="sort-dropdown-menu"
          trigger={(p) => (
            <button className="sort-dropdown-btn" data-education-id="sort-projects" {...p}>
              {SORT_LABELS[sortBy]}
              <ChevronIcon />
            </button>
          )}
        >
          {(Object.keys(SORT_LABELS) as SortOption[]).map((option) => (
            <DropdownItem
              key={option}
              active={sortBy === option}
              onSelect={() => onSortChange(option)}
            >
              <span>{SORT_LABELS[option]}</span>
              {sortBy === option && <CheckIcon />}
            </DropdownItem>
          ))}
        </Dropdown>
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
