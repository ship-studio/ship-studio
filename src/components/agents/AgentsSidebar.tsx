/**
 * The agent list, shown in the home sidebar in place of the projects while
 * Agents mode is on. It is built from the sidebar's own parts — the group
 * header, the full-bleed row, the badge, the status slot, the ghost
 * "Open project" action — so it reads as the same sidebar, not a second app.
 *
 * Right-click a row for Pin, Mark as unread, Edit, Hide and Delete. The
 * search button in the header (or ⌘F) reveals a field that searches every
 * conversation; while it has a query the results take the list's place.
 *
 * @module components/agents/AgentsSidebar
 */

import {
  AgentsIcon,
  BellIcon,
  DownloadIcon,
  EditIcon,
  EyeIcon,
  EyeOffIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from '@/components/icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../primitives/ContextMenu';
import { PixelLoaderRings } from '../workspace/PixelLoaderRings';
import { useRef, type RefObject } from 'react';
import { AgentAvatar } from './AgentAvatar';
import { AgentsSearchResults } from './AgentsSearchResults';
import { AgentsSearchBox, type AgentsSearchState } from './AgentsSearchBox';
import { useFlipReorder } from './useAgentMotion';
import { sortAgents, type Agent, type SearchHit } from '../../lib/agents';

interface AgentsSidebarProps {
  agents: Agent[];
  selectedId: string | null;
  showHidden: boolean;
  onToggleShowHidden: () => void;
  onSelect: (agentId: string) => void;
  onNew: () => void;
  onImport: () => void;
  onTogglePin: (agent: Agent) => void;
  onToggleHidden: (agent: Agent) => void;
  onMarkUnread: (agent: Agent) => void;
  onEdit: (agent: Agent) => void;
  onDelete: (agent: Agent) => void;
  search: AgentsSearchState;
  /** Reveal the field (or put it away, if it's showing). */
  onToggleSearch: () => void;
  /** ⌘F focuses this. */
  searchRef: RefObject<HTMLInputElement | null>;
  onOpenHit: (hit: SearchHit) => void;
}

/** Waiting on you: mid-turn on a card, or paused with one still open. */
export function needsYou(agent: Agent): boolean {
  return agent.status.state === 'waiting' || (agent.pendingApprovals ?? 0) > 0;
}

function subtitle(agent: Agent): string {
  if (needsYou(agent)) return 'Needs your OK';
  if (agent.status.state === 'working') return agent.status.activity ?? 'Working…';
  return agent.preview ?? agent.role ?? '';
}

export function AgentsSidebar({
  agents,
  selectedId,
  showHidden,
  onToggleShowHidden,
  onSelect,
  onNew,
  onImport,
  onTogglePin,
  onToggleHidden,
  onMarkUnread,
  onEdit,
  onDelete,
  search,
  onToggleSearch,
  searchRef,
  onOpenHit,
}: AgentsSidebarProps) {
  const query = search.query;
  const searching = search.open && query.trim().length > 0;
  const visible = sortAgents(agents).filter((a) => showHidden || !a.hidden || a.id === selectedId);
  const hiddenCount = agents.filter((a) => a.hidden).length;
  // An agent that just did something slides to the top instead of jumping.
  const listRef = useRef<HTMLDivElement>(null);
  useFlipReorder(listRef, '[data-agent-id]', visible.map((a) => a.id).join(' '));

  return (
    <div
      className="agents-list"
      role="navigation"
      aria-label="Agents"
      ref={listRef}
      data-agents-search-scope
    >
      <div className="sidebar-group-header agents-list__header">
        <span className="sidebar-group-symbol" aria-hidden="true">
          <AgentsIcon size={14} />
        </span>
        <span className="sidebar-group-label">Agents</span>
        <span className="sidebar-group-count">{agents.length}</span>
        <IconButton
          variant="ghost"
          size="compact"
          className="agents-list__search-toggle"
          icon={<SearchIcon size={12} />}
          // Keep focus in the field, so its blur doesn't close it a moment
          // before this click would.
          onMouseDown={(e) => e.preventDefault()}
          onClick={onToggleSearch}
          title="Search conversations (⌘F)"
          aria-label="Search conversations"
          aria-expanded={search.open}
          aria-controls="agents-list-search"
        />
        <IconButton
          variant="ghost"
          size="compact"
          className="agents-list__new"
          icon={<PlusIcon size={12} />}
          onClick={onNew}
          title="New agent (⌘N)"
          aria-label="New agent"
        />
      </div>

      <div
        id="agents-list-search"
        className="agents-list__search"
        data-open={search.open || undefined}
        inert={!search.open}
      >
        <div className="agents-list__search-inner">
          <AgentsSearchBox search={search} field={searchRef} />
        </div>
      </div>

      {searching && <AgentsSearchResults query={query} field={searchRef} onOpen={onOpenHit} />}

      {!searching &&
        visible.map((agent) => {
          const current = agent.id === selectedId;
          const waiting = needsYou(agent);
          const working = agent.status.state === 'working' && !waiting;
          const unread = !current && agent.unread > 0;
          return (
            <ContextMenu key={agent.id}>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  className={`agents-list__row${current ? ' is-current' : ''}`}
                  data-agent-id={agent.id}
                  data-hidden={agent.hidden || undefined}
                  aria-current={current ? 'true' : undefined}
                  onClick={() => onSelect(agent.id)}
                >
                  <AgentAvatar name={agent.name} color={agent.color} selected={current} />
                  <span className="agents-list__text">
                    <span className="agents-list__name">
                      {agent.name}
                      {agent.pinned && <PinIcon size={10} className="agents-list__pin" />}
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
                      <span className="agents-list__unread" aria-label="Unread" />
                    ) : null}
                  </span>
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent aria-label={`Actions for ${agent.name}`}>
                <ContextMenuItem onSelect={() => onTogglePin(agent)}>
                  <PinIcon size={12} /> {agent.pinned ? 'Unpin' : 'Pin'}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => onMarkUnread(agent)}>
                  <BellIcon size={12} /> Mark as unread
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => onEdit(agent)}>
                  <EditIcon size={12} /> Edit agent…
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => onToggleHidden(agent)}>
                  {agent.hidden ? <EyeIcon size={12} /> : <EyeOffIcon size={12} />}
                  {agent.hidden ? 'Show in sidebar' : 'Hide from sidebar'}
                </ContextMenuItem>
                {!agent.isMain && (
                  <ContextMenuItem variant="destructive" onSelect={() => onDelete(agent)}>
                    <TrashIcon size={12} /> Delete…
                  </ContextMenuItem>
                )}
              </ContextMenuContent>
            </ContextMenu>
          );
        })}

      {!searching && (
        <div className="workspace-sidebar-active-actions agents-list__actions">
          {hiddenCount > 0 && (
            <Button
              variant="ghost"
              width="fill"
              className="workspace-sidebar-add-project"
              onClick={onToggleShowHidden}
            >
              {showHidden ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
              <span>{showHidden ? 'Hide hidden agents' : `Show ${hiddenCount} hidden`}</span>
            </Button>
          )}
          <Button
            variant="ghost"
            width="fill"
            className="workspace-sidebar-add-project"
            onClick={onImport}
          >
            <DownloadIcon size={16} />
            <span>Import agents</span>
          </Button>
        </div>
      )}
    </div>
  );
}
