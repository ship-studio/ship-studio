/**
 * Below the compact breakpoint the sidebar is gone, so the header's title is
 * a menu of every agent, Team and Home. Each item carries the sidebar's own
 * marks (the loader, the attention and unread dots), so state reads the same
 * here as in the list it stands in for.
 *
 * @module components/agents/AgentSwitcher
 */

import type { ReactNode } from 'react';
import { CheckIcon, ChevronIcon, CollaboratorsIcon, HomeIcon } from '@/components/icons';
import { Dropdown, DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
import { PixelLoaderRings } from '../workspace/PixelLoaderRings';
import { AgentAvatar } from './AgentAvatar';
import { failedTurn, needsYou, sortAgents, TEAM_ID, type Agent } from '../../lib/agents';

interface AgentSwitcherProps {
  agents: Agent[];
  /** The agent on screen, or TEAM_ID. */
  currentId: string;
  /** What the trigger shows: the current agent's badge and name. */
  title: ReactNode;
  label: string;
  onOpenAgent: (agentId: string) => void;
  onGoHome: () => void;
}

/** The sidebar row's status slot, for a menu item. */
export function AgentMark({ agent }: { agent: Agent }) {
  const failure = failedTurn(agent);
  if (needsYou(agent)) {
    return <span className="sidebar-row-dot dot-attention" aria-label="Needs your OK" />;
  }
  if (agent.status.state === 'working') {
    return <PixelLoaderRings size="sm" label={`${agent.name} is working`} />;
  }
  if (failure) {
    return failure.kind === 'usage_limit' ? (
      <span className="sidebar-row-dot dot-waiting" aria-label="At its usage limit" />
    ) : (
      <span className="sidebar-row-dot dot-error" aria-label="Didn’t finish" />
    );
  }
  if (agent.unread > 0) return <span className="sidebar-row-dot dot-unread" aria-label="Unread" />;
  return null;
}

export function AgentSwitcher({
  agents,
  currentId,
  title,
  label,
  onOpenAgent,
  onGoHome,
}: AgentSwitcherProps) {
  return (
    <Dropdown
      portal
      className="agent-chat__switcher"
      menuClassName="agent-model-menu"
      trigger={(p) => (
        <MenuButton
          {...p}
          tabIndex={0}
          expanded={p['aria-expanded']}
          variant="ghost"
          className="agent-chat__title"
          aria-label={label}
        >
          {title}
          <ChevronIcon size={10} className={p['aria-expanded'] ? 'chevron-flipped' : undefined} />
        </MenuButton>
      )}
    >
      {sortAgents(agents)
        .filter((a) => !a.hidden || a.id === currentId)
        .map((a) => (
          <DropdownItem
            key={a.id}
            icon={<AgentAvatar name={a.name} color={a.color} size="mini" />}
            onSelect={() => onOpenAgent(a.id)}
          >
            <span className="agent-model-menu__label">{a.name}</span>
            <span className="agent-switcher__mark">
              {a.id === currentId ? (
                <CheckIcon size={12} aria-label="Open" />
              ) : (
                <AgentMark agent={a} />
              )}
            </span>
          </DropdownItem>
        ))}
      <DropdownDivider />
      <DropdownItem icon={<CollaboratorsIcon size={14} />} onSelect={() => onOpenAgent(TEAM_ID)}>
        <span className="agent-model-menu__label">Team</span>
        <span className="agent-switcher__mark">
          {currentId === TEAM_ID && <CheckIcon size={12} aria-label="Open" />}
        </span>
      </DropdownItem>
      <DropdownItem icon={<HomeIcon size={14} />} onSelect={onGoHome}>
        Home
      </DropdownItem>
    </Dropdown>
  );
}
