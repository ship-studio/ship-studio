/**
 * Per-agent setup flow after a card is clicked: the two steps (install, then
 * sign in) for the chosen agent. The next needed step starts automatically —
 * clicking the card IS the intent — and manual retry stays available through
 * the standard SetupItem rows when something fails or is cancelled. The
 * parent watches the pair and advances to the guided phase once both steps
 * are ready.
 */

import { ReactNode, useEffect, useRef } from 'react';
import { SetupItem } from '../SetupItem';
import { SetupItem as SetupItemType, getBlockingDependencies } from '../../../lib/setup';

interface AgentSetupDetailProps {
  /** Binary id of the agent being set up (e.g. "claude"). */
  binaryId: string;
  displayName: string;
  icon: ReactNode;
  items: SetupItemType[];
  onItemAction: (itemId: string) => void;
  activeItemId: string | null;
  terminalActive: boolean;
  /** Back to the agent grid. */
  onBack: () => void;
}

export function AgentSetupDetail({
  binaryId,
  displayName,
  icon,
  items,
  onItemAction,
  activeItemId,
  terminalActive,
  onBack,
}: AgentSetupDetailProps) {
  const binaryItem = items.find((i) => i.id === binaryId);
  const authItem = items.find((i) => i.id === `${binaryId}_auth`);
  const busy = activeItemId !== null || terminalActive;

  // Auto-start the next needed step, once per step per visit: install on
  // entry if missing, then sign-in once the install lands. Errors and
  // cancellations stop the autopilot — the rows' own buttons take over, so
  // a failing installer can't relaunch itself in a loop.
  const autoStartedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (busy || !binaryItem || !authItem) return;
    const next =
      binaryItem.status !== 'ready' ? binaryItem : authItem.status !== 'ready' ? authItem : null;
    if (!next) return;
    if (next.status === 'error' || next.status === 'in_progress') return;
    if (getBlockingDependencies(next.id, items).length > 0) return;
    if (autoStartedRef.current.has(next.id)) return;
    autoStartedRef.current.add(next.id);
    onItemAction(next.id);
  }, [busy, binaryItem, authItem, items, onItemAction]);

  if (!binaryItem || !authItem) return null;

  return (
    <div className="agent-setup-detail">
      <button type="button" className="agent-setup-detail-back" onClick={onBack} disabled={busy}>
        ← Choose a different agent
      </button>
      <div className="agent-setup-detail-header">
        <span className="agent-pick-card-icon">{icon}</span>
        <div>
          <h2 className="agent-setup-detail-name">{displayName}</h2>
          <p className="agent-setup-detail-sub">
            This is the agent that gets you set up — you can add more agents later.
          </p>
        </div>
      </div>
      <div className="wizard-step-items">
        {[binaryItem, authItem].map((item) => {
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
              isAnyActionInProgress={busy}
            />
          );
        })}
      </div>
    </div>
  );
}
