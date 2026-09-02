/**
 * Wizard Step 4: Hosting Provider
 *
 * Shows SetupItem rows for vercel and vercel_auth.
 * Always skippable — users can set up hosting later.
 */

import { SetupItem } from '../SetupItem';
import { Button } from '../../primitives/Button';
import {
  SetupItem as SetupItemType,
  getStepItems,
  getBlockingDependencies,
} from '../../../lib/setup';

interface HostingStepProps {
  items: SetupItemType[];
  onItemAction: (itemId: string) => void;
  activeItemId: string | null;
  terminalActive: boolean;
  onSkip: () => void;
}

export function HostingStep({
  items,
  onItemAction,
  activeItemId,
  terminalActive,
  onSkip,
}: HostingStepProps) {
  const stepItems = getStepItems('hosting', items);
  const isAnyActionInProgress = activeItemId !== null || terminalActive;

  return (
    <div className="wizard-step-items">
      {stepItems.map((item) => {
        const blockedBy = getBlockingDependencies(item.id, items);
        const isBlocked = blockedBy.length > 0 && item.status !== 'ready';
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
      <Button
        variant="secondary"
        className="wizard-hosting-skip"
        onClick={onSkip}
        disabled={isAnyActionInProgress}
      >
        Skip for Now
      </Button>
    </div>
  );
}
