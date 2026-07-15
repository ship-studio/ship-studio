/**
 * useProjectViewModeCommands — registers dashboard grid/list view commands.
 *
 * @module hooks/useProjectViewModeCommands
 */

import { useCommands } from '../commands/useCommands';
import { GridIcon, ListIcon } from '../components/icons';
import type { ProjectViewMode } from '../components/dashboard/ProjectGridView';

/**
 * Registers Cmd+K actions for switching the dashboard project view mode.
 * @param onViewModeChange - Callback that applies the selected dashboard view mode.
 */
export function useProjectViewModeCommands(onViewModeChange: (mode: ProjectViewMode) => void) {
  useCommands(
    () => [
      {
        id: 'dashboard.view.grid',
        title: 'Show projects as grid',
        icon: <GridIcon size={14} />,
        category: 'navigation',
        when: 'home',
        keywords: ['cards', 'tiles'],
        run: () => onViewModeChange('grid'),
      },
      {
        id: 'dashboard.view.list',
        title: 'Show projects as list',
        icon: <ListIcon size={14} />,
        category: 'navigation',
        when: 'home',
        keywords: ['rows', 'table', 'bulk select'],
        run: () => onViewModeChange('list'),
      },
    ],
    [onViewModeChange]
  );
}
