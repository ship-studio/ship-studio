/**
 * The agent list: who you have, what each last said, who's busy, who's
 * waiting on you. Right-click (or the row's menu) for Pin, Rename, Mark as
 * unread, Hide and Delete — the same verbs as Grok Bot's sidebar.
 *
 * @module components/agents/AgentsSidebar
 */

import { useMemo, useState } from 'react';
import {
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
  HomeIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
  EditIcon,
  BellIcon,
} from '@/components/icons';
import { IconButton } from '../primitives/IconButton';
import { TextButton } from '../primitives/TextButton';
import { TextField } from '../primitives/TextField';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../primitives/ContextMenu';
import { AgentAvatar } from './AgentAvatar';
import { sortAgents, type Agent } from '../../lib/agents';

interface AgentsSidebarProps {
  agents: Agent[];
  selectedId: string | null;
  onSelect: (agentId: string) => void;
  onNew: () => void;
  onImport: () => void;
  onGoProjects: () => void;
  onTogglePin: (agent: Agent) => void;
  onToggleHidden: (agent: Agent) => void;
  onMarkUnread: (agent: Agent) => void;
  onEdit: (agent: Agent) => void;
  onDelete: (agent: Agent) => void;
}

function rowSubtitle(agent: Agent): string {
  if (agent.status.state === 'waiting') return 'Needs your OK';
  if (agent.status.state === 'working') return agent.status.activity ?? 'Working…';
  return agent.preview ?? agent.role ?? '';
}

export function AgentsSidebar({
  agents,
  selectedId,
  onSelect,
  onNew,
  onImport,
  onGoProjects,
  onTogglePin,
  onToggleHidden,
  onMarkUnread,
  onEdit,
  onDelete,
}: AgentsSidebarProps) {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sortAgents(agents).filter((a) => {
      if (q) return a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q);
      return showHidden || !a.hidden || a.id === selectedId;
    });
  }, [agents, query, showHidden, selectedId]);
  const hiddenCount = agents.filter((a) => a.hidden).length;

  return (
    <aside className="agents-sidebar" aria-label="Agents">
      <div className="workspace-sidebar-top-row agents-sidebar__top">
        <IconButton
          variant="ghost"
          className="workspace-sidebar-home"
          icon={<HomeIcon size={12} />}
          onClick={onGoProjects}
          title="Projects"
          aria-label="Back to projects"
        />
        <span className="agents-sidebar__spacer" />
        <IconButton
          variant="ghost"
          className="workspace-sidebar-home"
          icon={<SearchIcon size={12} />}
          onClick={() => {
            setSearching((v) => !v);
            setQuery('');
          }}
          aria-pressed={searching}
          title="Search agents"
          aria-label="Search agents"
        />
        <IconButton
          variant="ghost"
          className="workspace-sidebar-home"
          icon={<PlusIcon size={12} />}
          onClick={onNew}
          title="New agent"
          aria-label="New agent"
        />
      </div>

      {searching && (
        <div className="agents-sidebar__search">
          <TextField
            autoFocus
            placeholder="Search agents"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setSearching(false);
                setQuery('');
              }
            }}
            aria-label="Search agents"
          />
        </div>
      )}

      <nav className="agents-sidebar__list">
        {visible.map((agent) => (
          <ContextMenu key={agent.id}>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                className="agents-row"
                data-agent-id={agent.id}
                aria-current={agent.id === selectedId ? 'true' : undefined}
                data-hidden={agent.hidden || undefined}
                onClick={() => onSelect(agent.id)}
              >
                <AgentAvatar
                  shape={agent.shape}
                  color={agent.color}
                  size={34}
                  working={agent.status.state === 'working'}
                />
                <span className="agents-row__text">
                  <span className="agents-row__name">
                    {agent.name}
                    {agent.pinned && <PinIcon size={10} className="agents-row__pin" />}
                  </span>
                  <span className="agents-row__preview" data-state={agent.status.state}>
                    {rowSubtitle(agent)}
                  </span>
                </span>
                {agent.status.state === 'waiting' ? (
                  <span
                    className="agents-row__badge agents-row__badge--waiting"
                    aria-label="Waiting for you"
                  >
                    !
                  </span>
                ) : agent.unread > 0 && agent.id !== selectedId ? (
                  <span className="agents-row__badge" aria-label={`${agent.unread} unread`}>
                    {agent.unread > 9 ? '9+' : agent.unread}
                  </span>
                ) : null}
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => onTogglePin(agent)}>
                <PinIcon size={12} /> {agent.pinned ? 'Unpin' : 'Pin'}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onMarkUnread(agent)}>
                <BellIcon size={12} /> Mark as unread
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => onEdit(agent)}>
                <EditIcon size={12} /> Edit agent
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => onToggleHidden(agent)}>
                {agent.hidden ? <EyeIcon size={12} /> : <EyeOffIcon size={12} />}
                {agent.hidden ? 'Show in sidebar' : 'Hide from sidebar'}
              </ContextMenuItem>
              {!agent.isMain && (
                <ContextMenuItem variant="destructive" onSelect={() => onDelete(agent)}>
                  <TrashIcon size={12} /> Delete
                </ContextMenuItem>
              )}
            </ContextMenuContent>
          </ContextMenu>
        ))}
        {hiddenCount > 0 && !query && (
          <TextButton
            className="agents-sidebar__hidden-toggle"
            onClick={() => setShowHidden((v) => !v)}
          >
            {showHidden ? 'Hide hidden agents' : `${hiddenCount} hidden`}
          </TextButton>
        )}
      </nav>

      <div className="agents-sidebar__footer">
        <TextButton className="agents-sidebar__import" onClick={onImport}>
          <DownloadIcon size={12} /> Import agents
        </TextButton>
      </div>
    </aside>
  );
}
