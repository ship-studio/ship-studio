/**
 * DashboardSearch — command-palette trigger for the dashboard home screen.
 *
 * @module components/DashboardSearch
 */

import { useModal } from '../../contexts/ModalContext';
import { kbd } from '../../lib/shortcuts';
import { SearchIcon } from '@/components/icons';

/** Renders the dashboard search control backed by the shared dashboard filters. */
export function DashboardSearch() {
  const palette = useModal('commandPalette');

  return (
    <button
      type="button"
      className="dashboard-search"
      data-education-id="search-projects"
      onClick={() => palette.open()}
      title="Open command palette"
      aria-label="Open command palette"
    >
      <span className="dashboard-search-inner">
        <SearchIcon size={12} />
        <span className="dashboard-search-placeholder text-style-body-medium">
          Search projects, actions, settings...
        </span>
        <span className="workspace-sidebar-filter-shortcut dashboard-search-shortcut">
          {kbd('mod', 'K')}
        </span>
      </span>
    </button>
  );
}
