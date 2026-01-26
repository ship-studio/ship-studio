/**
 * Checklist of all setup items with their current status.
 *
 * Handles the display and action delegation for each item,
 * respecting dependencies and blocked states.
 */

import { SetupItem } from './SetupItem';
import {
  SetupItem as SetupItemType,
  SETUP_ITEM_ORDER,
  getBlockingDependencies,
} from '../../lib/setup';

interface SetupChecklistProps {
  items: SetupItemType[];
  /** Called when user clicks an action button */
  onItemAction: (itemId: string) => void;
  /** ID of item currently being processed */
  activeItemId?: string | null;
  /** Whether a terminal is currently active */
  terminalActive?: boolean;
}

export function SetupChecklist({
  items,
  onItemAction,
  activeItemId,
  terminalActive,
}: SetupChecklistProps) {
  // Sort items according to display order
  const sortedItems = [...items].sort((a, b) => {
    const aIndex = SETUP_ITEM_ORDER.indexOf(a.id);
    const bIndex = SETUP_ITEM_ORDER.indexOf(b.id);
    return aIndex - bIndex;
  });

  // Disable all buttons if any action is in progress or terminal is active
  const isAnyActionInProgress = activeItemId !== null || terminalActive === true;

  return (
    <div className="setup-checklist">
      {sortedItems.map((item) => {
        const blockedBy = getBlockingDependencies(item.id, items);
        const isBlocked = blockedBy.length > 0 && item.status !== 'ready';

        // Override status to blocked if dependencies aren't ready
        const displayItem: SetupItemType = isBlocked ? { ...item, status: 'blocked' } : item;

        return (
          <SetupItem
            key={item.id}
            item={displayItem}
            blockedBy={blockedBy}
            onAction={() => onItemAction(item.id)}
            isActionInProgress={activeItemId === item.id}
            isAnyActionInProgress={isAnyActionInProgress}
          />
        );
      })}
    </div>
  );
}
