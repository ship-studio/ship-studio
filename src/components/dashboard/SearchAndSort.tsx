/**
 * SearchAndSort — the two-row heading and actions area inside the projects
 * panel.
 *
 * @module components/SearchAndSort
 */

import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { Tabs, TabsList, TabsTab } from '../primitives/Tabs';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import {
  ChevronIcon,
  CheckIcon,
  FolderPlusIcon,
  GridIcon,
  ListIcon,
  PlusIcon,
  PullIcon,
} from '@/components/icons';
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
  onCreateProject: () => void;
  onImportProject?: () => void;
  /** Whether GitHub is authenticated (import requires GitHub). */
  isGitHubAuthenticated?: boolean;
  /** Callback when the user tries to import without GitHub auth. */
  onGitHubConnectForImport?: () => void;
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
  onCreateProject,
  onImportProject,
  isGitHubAuthenticated = true,
  onGitHubConnectForImport,
  titleAccessory,
}: SearchAndSortProps) {
  return (
    <div className="dashboard-section-header">
      <div className="dashboard-section-heading">
        <div className="dashboard-section-heading-title">
          <span className="dashboard-section-title text-style-h4">{title}</span>
          {totalCount > 0 && (
            <span className="dashboard-section-count text-style-h4 font-weight-heading">
              {totalCount}
            </span>
          )}
        </div>
        {titleAccessory}
      </div>
      <div className="dashboard-section-controls">
        <div className="dashboard-section-actions-left">
          <Button
            variant="primary"
            size="default"
            width="hug"
            className="dashboard-action-button text-style-control-semibold"
            leftIcon={<PlusIcon size={14} />}
            data-education-id="new-project-button"
            onClick={() => {
              void trackEvent('new_project_clicked', { $screen_name: 'Dashboard' });
              onCreateProject();
            }}
          >
            New Project
          </Button>

          {onImportProject && (
            <Button
              variant="default"
              size="default"
              width="hug"
              className="dashboard-action-button text-style-control-semibold"
              leftIcon={<PullIcon size={14} />}
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

          <IconButton
            variant="default"
            size="default"
            width="hug"
            className="new-folder-btn"
            data-education-id="new-folder-button"
            onClick={() => {
              void trackEvent('new_folder_clicked', { $screen_name: 'Dashboard' });
              onNewFolder();
            }}
            title="New Folder"
            aria-label="New Folder"
            icon={<FolderPlusIcon size={14} />}
          />
        </div>

        <div className="dashboard-section-actions-right">
          <Tabs
            value={viewMode}
            size="default"
            mode="navigation"
            onValueChange={(next) => onViewModeChange(next as ProjectViewMode)}
          >
            <TabsList variant="stretch" className="dashboard-view-toggle" aria-label="Project view">
              <TabsTab
                value="grid"
                variant={viewMode === 'grid' ? 'default' : 'ghost'}
                className="dashboard-view-toggle-btn text-style-control-semibold"
                leftIcon={<GridIcon size={14} />}
                aria-label="Grid view"
                title="Grid view"
              >
                <span className="dashboard-view-toggle-label">Grid</span>
              </TabsTab>
              <TabsTab
                value="list"
                variant={viewMode === 'list' ? 'default' : 'ghost'}
                className="dashboard-view-toggle-btn text-style-control-semibold"
                leftIcon={<ListIcon size={14} />}
                aria-label="List view"
                title="List view"
              >
                <span className="dashboard-view-toggle-label">List</span>
              </TabsTab>
            </TabsList>
          </Tabs>
          <Dropdown
            align="right"
            menuClassName="sort-dropdown-menu"
            trigger={(p) => (
              <Button
                variant="default"
                size="default"
                width="hug"
                className="sort-dropdown-btn text-style-control-semibold"
                data-education-id="sort-projects"
                rightIcon={<ChevronIcon />}
                {...p}
              >
                {SORT_LABELS[sortBy]}
              </Button>
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
        </div>
      </div>
    </div>
  );
}
