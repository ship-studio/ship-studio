/**
 * The agent list, shown in the home sidebar in place of the projects while
 * Agents mode is on. It is built from the sidebar's own parts — the
 * full-bleed row with a hairline under it, the badge, the status slot and the
 * shared status dots — so it reads as the same sidebar, not a second app.
 *
 * There is one group, so there is no group header: the Agents nav row above
 * it is the heading, and carries the + menu (`AgentsNavActions`). The
 * sidebar's top field searches conversations here; while it has a query the
 * results take the list's place.
 *
 * Right-click a row (or Shift+F10 on it) for Pin, Mark as unread, Mute notifications, Edit, Hide
 * and Delete; the conversation header's … menu has the same items for the
 * open agent.
 *
 * @module components/agents/AgentsSidebar
 */

import { useRef, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import {
  BellOffIcon,
  ChevronRightIcon,
  CollaboratorsIcon,
  DownloadIcon,
  EditIcon,
  PinIcon,
  PlusIcon,
} from '@/components/icons';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '../primitives/ContextMenu';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { IconButton } from '../primitives/IconButton';
import { AgentAvatar } from './AgentAvatar';
import { AgentActionItems, type AgentActions } from './AgentActions';
import { AgentsSearchResults } from './AgentsSearchResults';
import { AgentMark } from './AgentSwitcher';
import { useFlipReorder } from './useAgentMotion';
import {
  failedTurn,
  failureLine,
  needsYou,
  sortAgents,
  teamSubtitle,
  TEAM_ID,
  type Agent,
  type SearchHit,
} from '../../lib/agents';
import { kbd } from '../../lib/shortcuts';

interface AgentsSidebarProps extends AgentActions {
  agents: Agent[];
  selectedId: string | null;
  showHidden: boolean;
  onToggleShowHidden: () => void;
  onSelect: (agentId: string) => void;
  /** The top field's query; while there is one, its results replace the list. */
  query: string;
  searchRef: RefObject<HTMLInputElement | null>;
  onOpenHit: (hit: SearchHit) => void;
  /** The hit last opened, marked as the row is. */
  currentHit?: string | null;
}

function subtitle(agent: Agent): string {
  if (needsYou(agent)) return 'Needs your OK';
  if (agent.status.state === 'working') return agent.status.activity ?? 'Working…';
  const failure = failedTurn(agent);
  if (failure) return failureLine(failure, agent.preview);
  return agent.preview ?? agent.role ?? '';
}

/** The row's second line takes the colour of its state. */
function lineState(agent: Agent): string | undefined {
  if (needsYou(agent)) return 'waiting';
  if (agent.status.state === 'working') return 'working';
  const failure = failedTurn(agent);
  if (failure) return failure.kind === 'usage_limit' ? 'limited' : 'failed';
  return undefined;
}

/** The full name as a tooltip only when the row cuts it short. */
function tooltipIfTruncated(event: PointerEvent<HTMLElement>) {
  const row = event.currentTarget;
  const text = row.querySelector<HTMLElement>('.agents-list__name-text');
  if (text && text.scrollWidth > text.clientWidth) {
    row.setAttribute('data-tooltip-content', text.textContent ?? '');
  } else {
    row.removeAttribute('data-tooltip-content');
  }
}

/**
 * The list is one Tab stop (the current row's); up and down move between
 * rows, Home and End to the ends. Shift+F10 or the context-menu key opens a
 * row's menu, as a right-click does.
 */
function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  const row = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
    '[data-agent-id]'
  );
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    if (!row) return;
    event.preventDefault();
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.bottom,
      })
    );
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-agent-id]'));
  const index = row ? rows.indexOf(row) : -1;
  if (index === -1) return;
  event.preventDefault();
  const next =
    event.key === 'Home'
      ? rows[0]
      : event.key === 'End'
        ? rows[rows.length - 1]
        : rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
  next?.focus();
}

export function AgentsSidebar({
  agents,
  selectedId,
  showHidden,
  onToggleShowHidden,
  onSelect,
  query,
  searchRef,
  onOpenHit,
  currentHit,
  ...actions
}: AgentsSidebarProps) {
  const searching = query.trim().length > 0;
  const sorted = sortAgents(agents);
  const visible = sorted.filter((a) => !a.hidden || a.id === selectedId);
  const hidden = sorted.filter((a) => a.hidden && a.id !== selectedId);
  // An agent that just did something slides to the top instead of jumping.
  const listRef = useRef<HTMLDivElement>(null);
  const shown = showHidden ? [...visible, ...hidden] : visible;
  useFlipReorder(listRef, '[data-agent-id]', shown.map((a) => a.id).join(' '));

  // The one row in the Tab order: the open one, else the first.
  const tabStop = [TEAM_ID, ...shown.map((a) => a.id)].includes(selectedId ?? '')
    ? selectedId
    : TEAM_ID;

  const row = (agent: Agent) => {
    const current = agent.id === selectedId;
    return (
      <ContextMenu key={agent.id}>
        <ContextMenuTrigger asChild>
          {/* tabIndex: WebKit leaves buttons out of the Tab order unless asked. */}
          <button
            type="button"
            tabIndex={agent.id === tabStop ? 0 : -1}
            className={`agents-list__row${current ? ' is-current' : ''}`}
            data-agent-id={agent.id}
            data-hidden={agent.hidden || undefined}
            aria-current={current ? 'true' : undefined}
            onPointerEnter={tooltipIfTruncated}
            onClick={() => onSelect(agent.id)}
          >
            <AgentAvatar name={agent.name} color={agent.color} selected={current} />
            <span className="agents-list__text">
              <span className="agents-list__name">
                <span className="agents-list__name-text">{agent.name}</span>
                {agent.pinned && (
                  <PinIcon size={12} className="agents-list__pin" aria-label="Pinned" />
                )}
                {agent.muted && (
                  <BellOffIcon size={12} className="agents-list__pin" aria-label="Muted" />
                )}
              </span>
              <span className="agents-list__preview" data-state={lineState(agent)}>
                {subtitle(agent)}
              </span>
            </span>
            <span className="agents-list__status">
              {/* Read already when it's the one open: no unread dot for it. */}
              <AgentMark agent={current ? { ...agent, unread: 0 } : agent} />
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
      {searching ? (
        <AgentsSearchResults
          query={query}
          field={searchRef}
          onOpen={onOpenHit}
          currentId={currentHit}
        />
      ) : (
        <>
          <TeamRow
            agents={agents}
            current={selectedId === TEAM_ID}
            tabStop={tabStop === TEAM_ID}
            onSelect={() => onSelect(TEAM_ID)}
          />
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
        </>
      )}
    </div>
  );
}

/**
 * The first row: the Team overview, what's in flight across every agent.
 * Built like an agent row, with the team's badge in place of initials.
 */
function TeamRow({
  agents,
  current,
  tabStop,
  onSelect,
}: {
  agents: Agent[];
  current: boolean;
  tabStop: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      tabIndex={tabStop ? 0 : -1}
      className={`agents-list__row${current ? ' is-current' : ''}`}
      data-agent-id={TEAM_ID}
      aria-current={current ? 'true' : undefined}
      title="Team: what's in flight"
      onClick={onSelect}
    >
      <span
        className={`agent-avatar agent-avatar--row agents-team__badge${current ? ' agent-avatar--selected' : ''}`}
        aria-hidden
      >
        <CollaboratorsIcon size={14} />
      </span>
      <span className="agents-list__text">
        <span className="agents-list__name">
          <span className="agents-list__name-text">Team</span>
        </span>
        <span className="agents-list__preview">{teamSubtitle(agents)}</span>
      </span>
      <span className="agents-list__status" />
    </button>
  );
}

/** The + on the Agents nav row: a new agent, or bring some over. */
export function AgentsNavActions({ onNew, onImport }: { onNew: () => void; onImport: () => void }) {
  return (
    <div className="workspace-sidebar-agents-actions">
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
    </div>
  );
}
