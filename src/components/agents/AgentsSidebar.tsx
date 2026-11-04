/**
 * The agent list, shown in the home sidebar in place of the projects while
 * Agents mode is on. It is built from the sidebar's own parts — the
 * full-bleed row with a hairline under it, the badge, the status slot and the
 * shared status dots — so it reads as the same sidebar, not a second app.
 *
 * There is one group, so there is no group header: the Agents nav row above
 * it is the heading, and carries the + menu (`AgentsAddMenu`).
 *
 * Right-click a row for Pin, Mark as unread, Edit, Hide and Delete; the
 * conversation header's … menu has the same items for the open agent.
 *
 * @module components/agents/AgentsSidebar
 */

import { useRef, type KeyboardEvent } from 'react';
import { ChevronRightIcon, DownloadIcon, EditIcon, PinIcon, PlusIcon } from '@/components/icons';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '../primitives/ContextMenu';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { IconButton } from '../primitives/IconButton';
import { PixelLoaderRings } from '../workspace/PixelLoaderRings';
import { AgentAvatar } from './AgentAvatar';
import { AgentActionItems, type AgentActions } from './AgentActions';
import { useFlipReorder } from './useAgentMotion';
import { needsYou, sortAgents, type Agent } from '../../lib/agents';
import { kbd } from '../../lib/shortcuts';

interface AgentsSidebarProps extends AgentActions {
  agents: Agent[];
  selectedId: string | null;
  showHidden: boolean;
  onToggleShowHidden: () => void;
  onSelect: (agentId: string) => void;
}

function subtitle(agent: Agent): string {
  if (needsYou(agent)) return 'Needs your OK';
  if (agent.status.state === 'working') return agent.status.activity ?? 'Working…';
  return agent.preview ?? agent.role ?? '';
}

/** Up and down move between rows, the way they do in any list. */
function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-agent-id]'));
  const index = rows.indexOf(document.activeElement as HTMLElement);
  if (index === -1) return;
  event.preventDefault();
  const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
  next?.focus();
}

export function AgentsSidebar({
  agents,
  selectedId,
  showHidden,
  onToggleShowHidden,
  onSelect,
  ...actions
}: AgentsSidebarProps) {
  const sorted = sortAgents(agents);
  const visible = sorted.filter((a) => !a.hidden || a.id === selectedId);
  const hidden = sorted.filter((a) => a.hidden && a.id !== selectedId);
  // An agent that just did something slides to the top instead of jumping.
  const listRef = useRef<HTMLDivElement>(null);
  const shown = showHidden ? [...visible, ...hidden] : visible;
  useFlipReorder(listRef, '[data-agent-id]', shown.map((a) => a.id).join(' '));

  const row = (agent: Agent) => {
    const current = agent.id === selectedId;
    const waiting = needsYou(agent);
    const working = agent.status.state === 'working' && !waiting;
    const unread = !current && agent.unread > 0;
    return (
      <ContextMenu key={agent.id}>
        <ContextMenuTrigger asChild>
          {/* tabIndex: WebKit leaves buttons out of the Tab order unless asked. */}
          <button
            type="button"
            tabIndex={0}
            className={`agents-list__row${current ? ' is-current' : ''}`}
            data-agent-id={agent.id}
            data-hidden={agent.hidden || undefined}
            aria-current={current ? 'true' : undefined}
            title={agent.name}
            onClick={() => onSelect(agent.id)}
          >
            <AgentAvatar name={agent.name} color={agent.color} selected={current} />
            <span className="agents-list__text">
              <span className="agents-list__name">
                <span className="agents-list__name-text">{agent.name}</span>
                {agent.pinned && (
                  <PinIcon size={12} className="agents-list__pin" aria-label="Pinned" />
                )}
              </span>
              <span
                className="agents-list__preview"
                data-state={waiting ? 'waiting' : working ? 'working' : undefined}
              >
                {subtitle(agent)}
              </span>
            </span>
            <span className="agents-list__status">
              {working ? (
                <PixelLoaderRings size="sm" label={`${agent.name} is working`} />
              ) : waiting ? (
                <span className="sidebar-row-dot dot-attention" aria-label="Needs your OK" />
              ) : unread ? (
                <span className="sidebar-row-dot dot-unread" aria-label="Unread" />
              ) : null}
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent aria-label={`Actions for ${agent.name}`}>
          <AgentActionItems agent={agent} kind="context" {...actions} />
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  return (
    <div
      className="agents-list"
      role="navigation"
      aria-label="Agents"
      ref={listRef}
      onKeyDown={onListKeyDown}
    >
      {visible.map(row)}
      {hidden.length > 0 && (
        <button
          type="button"
          tabIndex={0}
          className="agents-list__hidden-toggle"
          aria-expanded={showHidden}
          onClick={onToggleShowHidden}
        >
          <ChevronRightIcon size={10} className="agents-list__hidden-chevron" />
          Hidden ({hidden.length})
        </button>
      )}
      {showHidden && hidden.map(row)}
    </div>
  );
}

/** The + on the Agents nav row: a new agent, or bring some over. */
export function AgentsAddMenu({ onNew, onImport }: { onNew: () => void; onImport: () => void }) {
  return (
    <Dropdown
      align="right"
      portal
      trigger={(p) => (
        <IconButton
          {...p}
          tabIndex={0}
          variant="ghost"
          size="compact"
          className="workspace-sidebar-agents-add"
          icon={<PlusIcon size={12} />}
          title={`New agent (${kbd('mod', 'N')})`}
          aria-label="New agent"
        />
      )}
    >
      <DropdownItem icon={<EditIcon size={14} />} onSelect={onNew}>
        New agent…
      </DropdownItem>
      <DropdownItem icon={<DownloadIcon size={14} />} onSelect={onImport}>
        Import agents…
      </DropdownItem>
    </Dropdown>
  );
}
