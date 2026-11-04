/**
 * An agent's badge: its initials on a tile tinted with its colour. The same
 * shape and type as a project's badge in the sidebar, so agents read as part
 * of Ship Studio rather than as a separate app's mascots.
 *
 * @module components/agents/AgentAvatar
 */

import { useSyncExternalStore } from 'react';
import { getAgentsSnapshot, subscribeAgents } from '../../lib/agentsStore';

/**
 * "Chief of Staff" → "CS", "Finance" → "FI", "Acme Site" → "AS". A number
 * keeps its digits ("Agent 3" → "A3", "Agent 12" → "12"), so a numbered run
 * of agents doesn't collapse onto one badge.
 */
export function agentInitials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter(
      (w) => /[A-Za-z0-9]/.test(w) && !['of', 'the', 'and', 'for', '&'].includes(w.toLowerCase())
    );
  const number = words.length >= 2 ? words[words.length - 1] : '';
  if (/^\d+$/.test(number)) {
    return number.length >= 2 ? number.slice(-2) : (words[0][0] + number).toUpperCase();
  }
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const word = words[0] ?? name.trim();
  return word.slice(0, 2).toUpperCase();
}

/** The first letter and the next consonant: "Client Sites QA" → "CL". */
function consonantInitials(name: string): string {
  const letters = name.replace(/[^A-Za-z0-9]/g, '');
  const next = letters.slice(1).match(/[b-df-hj-np-tv-z0-9]/i)?.[0] ?? letters[1] ?? '';
  return (letters[0] + next).toUpperCase();
}

/**
 * Initials that don't collide with an agent listed before this one
 * (`names`, in creation order, the Chief first): "Chief of Staff" keeps "CS"
 * and "Client Sites QA" becomes "CL". A name not in the list (one being
 * typed) gives way to all of them.
 */
export function distinctInitials(name: string, names: string[]): string {
  const own = agentInitials(name);
  const index = names.indexOf(name);
  const before = index === -1 ? names : names.slice(0, index);
  return before.some((n) => n !== name && agentInitials(n) === own) ? consonantInitials(name) : own;
}

/** Visible agents' names in creation order, Chief first, as one stable string. */
const teamNames = () =>
  [...getAgentsSnapshot().agents]
    .filter((a) => !a.hidden)
    .sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.createdAt - b.createdAt)
    .map((a) => a.name)
    .join('\n');

interface AgentAvatarProps {
  name: string;
  color: string;
  /**
   * `row` is the sidebar's badge (a project badge's size and type), `field`
   * sits beside a text field at control height, `hero` heads an empty chat,
   * `mini` leads a menu item.
   */
  size?: 'row' | 'field' | 'hero' | 'mini';
  /** Solid fill, for the agent you're looking at (like the current project's badge). */
  selected?: boolean;
  className?: string;
}

export function AgentAvatar({
  name,
  color,
  size = 'row',
  selected = false,
  className,
}: AgentAvatarProps) {
  // A string snapshot, so a streaming reply (which updates the store every
  // few frames) never re-renders a badge.
  const names = useSyncExternalStore(subscribeAgents, teamNames);
  return (
    <span
      className={`agent-avatar agent-avatar--${size}${selected ? ' agent-avatar--selected' : ''}${
        className ? ` ${className}` : ''
      }`}
      data-color={color}
      aria-hidden
    >
      {distinctInitials(name, names ? names.split('\n') : [])}
    </span>
  );
}
