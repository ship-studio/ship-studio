/**
 * Wizard Step 3: AI Agent
 *
 * Groups items into agent pair cards (Claude Code + Codex).
 * Shows install/connect UI for each agent pair.
 * When both pairs are ready, shows default agent selection inline.
 */

import { useState } from 'react';
import { SetupItem } from '../SetupItem';
import {
  SetupItem as SetupItemType,
  AGENT_ITEM_PAIRS,
  getReadyAgentPairs,
  getBlockingDependencies,
  SETUP_FRIENDLY_NAMES,
} from '../../../lib/setup';
import { ALL_AGENTS } from '../../../lib/agent';

interface AgentStepProps {
  items: SetupItemType[];
  onItemAction: (itemId: string) => void;
  activeItemId: string | null;
  terminalActive: boolean;
  /** Called when user selects a default agent (when both are ready) */
  onAgentSelect?: (agentId: string) => void;
  /** Currently selected default agent ID */
  selectedAgentId?: string | null;
}

export function AgentStep({
  items,
  onItemAction,
  activeItemId,
  terminalActive,
  onAgentSelect,
  selectedAgentId,
}: AgentStepProps) {
  const isAnyActionInProgress = activeItemId !== null || terminalActive;
  const readyPairs = getReadyAgentPairs(items);
  const showSelection = readyPairs.length > 1;
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(selectedAgentId ?? null);

  const handleAgentSelect = (agentId: string) => {
    setLocalSelectedId(agentId);
    onAgentSelect?.(agentId);
  };

  return (
    <div className="wizard-step-items">
      {showSelection && (
        <p className="wizard-agent-selection-hint">
          {readyPairs.length} agents are ready. Choose your default below.
        </p>
      )}

      {AGENT_ITEM_PAIRS.map((pair) => {
        const binaryItem = items.find((i) => i.id === pair.binaryId);
        const authItem = items.find((i) => i.id === pair.authId);
        if (!binaryItem || !authItem) return null;

        const isPairReady = binaryItem.status === 'ready' && authItem.status === 'ready';
        const agentConfig = ALL_AGENTS.find(
          (a) =>
            a.binaryName === pair.binaryId ||
            a.id === (pair.binaryId === 'claude' ? 'claude-code' : pair.binaryId)
        );
        const agentId = agentConfig?.id ?? pair.binaryId;
        const displayName =
          agentConfig?.displayName ?? SETUP_FRIENDLY_NAMES[pair.binaryId] ?? pair.binaryId;
        const isRecommended = pair.binaryId === 'claude';

        return (
          <div
            key={pair.binaryId}
            className={`wizard-agent-card ${isPairReady ? 'ready' : ''} ${showSelection && localSelectedId === agentId ? 'selected' : ''}`}
            onClick={showSelection && isPairReady ? () => handleAgentSelect(agentId) : undefined}
            role={showSelection ? 'button' : undefined}
            tabIndex={showSelection ? 0 : undefined}
          >
            <div className="wizard-agent-card-header">
              <div className="wizard-agent-card-title">
                <span className="wizard-agent-card-name">{displayName}</span>
                {isRecommended && <span className="wizard-agent-card-badge">Recommended</span>}
              </div>
              {showSelection && isPairReady && localSelectedId === agentId && (
                <div className="wizard-agent-card-check">
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <circle cx="10" cy="10" r="10" fill="var(--success)" />
                    <path
                      d="M6 10l3 3 5-6"
                      stroke="white"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
              )}
            </div>

            <div className="wizard-agent-card-items">
              {[binaryItem, authItem].map((item) => {
                const blockedBy = getBlockingDependencies(item.id, items);
                const isBlocked = blockedBy.length > 0 && item.status !== 'ready';
                const displayItem: SetupItemType = isBlocked
                  ? { ...item, status: 'blocked' }
                  : item;

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
          </div>
        );
      })}
    </div>
  );
}
