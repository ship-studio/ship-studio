/**
 * What you can do to an agent: Pin, Mark as unread, Mute, Edit, Hide, Delete. One
 * list, rendered as a row's right-click menu or as the conversation header's
 * … menu, so the two never drift apart.
 *
 * @module components/agents/AgentActions
 */

import type { ReactNode } from 'react';
import {
  BellIcon,
  BellOffIcon,
  CommentIcon,
  EditIcon,
  EyeIcon,
  EyeOffIcon,
  PinIcon,
  TrashIcon,
} from '@/components/icons';
import { ContextMenuItem, ContextMenuSeparator } from '../primitives/ContextMenu';
import { DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import type { Agent } from '../../lib/agents';

export interface AgentActions {
  onTogglePin: (agent: Agent) => void;
  onToggleHidden: (agent: Agent) => void;
  onToggleMuted: (agent: Agent) => void;
  onMarkUnread: (agent: Agent) => void;
  onEdit: (agent: Agent) => void;
  onDelete: (agent: Agent) => void;
}

interface Item {
  label: string;
  icon: ReactNode;
  run: () => void;
  danger?: boolean;
  divider?: boolean;
}

export function AgentActionItems({
  agent,
  kind,
  onTogglePin,
  onToggleHidden,
  onToggleMuted,
  onMarkUnread,
  onEdit,
  onDelete,
}: { agent: Agent; kind: 'context' | 'dropdown' } & AgentActions) {
  const items: Item[] = [
    {
      label: agent.pinned ? 'Unpin' : 'Pin',
      icon: <PinIcon size={12} />,
      run: () => onTogglePin(agent),
    },
    { label: 'Mark as unread', icon: <CommentIcon size={12} />, run: () => onMarkUnread(agent) },
    {
      label: agent.muted ? 'Unmute notifications' : 'Mute notifications',
      icon: agent.muted ? <BellIcon size={12} /> : <BellOffIcon size={12} />,
      run: () => onToggleMuted(agent),
    },
    { label: 'Edit agent…', icon: <EditIcon size={12} />, run: () => onEdit(agent) },
    {
      label: agent.hidden ? 'Show in sidebar' : 'Hide from sidebar',
      icon: agent.hidden ? <EyeIcon size={12} /> : <EyeOffIcon size={12} />,
      run: () => onToggleHidden(agent),
      divider: true,
    },
  ];
  if (!agent.isMain) {
    items.push({
      label: 'Delete…',
      icon: <TrashIcon size={12} />,
      run: () => onDelete(agent),
      danger: true,
    });
  }

  return (
    <>
      {items.map((item) => [
        item.divider &&
          (kind === 'context' ? (
            <ContextMenuSeparator key={`${item.label}-divider`} />
          ) : (
            <DropdownDivider key={`${item.label}-divider`} />
          )),
        kind === 'context' ? (
          <ContextMenuItem
            key={item.label}
            variant={item.danger ? 'destructive' : 'default'}
            onSelect={item.run}
          >
            {item.icon} {item.label}
          </ContextMenuItem>
        ) : (
          <DropdownItem
            key={item.label}
            icon={item.icon}
            variant={item.danger ? 'danger' : 'default'}
            onSelect={item.run}
          >
            {item.label}
          </DropdownItem>
        ),
      ])}
    </>
  );
}
