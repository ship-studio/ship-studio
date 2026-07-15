/**
 * Phase 0 agent picker: five square cards (3 + 2 centered) in the style of
 * the dashboard's agent section — icon, name, one-line description. Clicking
 * a card enters that agent's two-step install → sign-in flow; "Other" opens a
 * plain terminal for any agent CLI we don't manage. Cards surface what's
 * already detected on the machine ("Ready" / "Installed") so returning users
 * see their agent is one click away.
 */

import { ReactNode } from 'react';
import { SetupItem } from '../../../lib/setup';
import { ClaudeIcon, CodexIcon, CursorIcon, OpencodeIcon, TerminalIcon } from '../../icons';

/** Card key: an agent binary id, or 'other' for the bring-your-own terminal. */
export type AgentCardKey = 'claude' | 'codex' | 'cursor' | 'opencode' | 'other';

interface CardDef {
  key: AgentCardKey;
  name: string;
  description: string;
  icon: ReactNode;
}

// Order is the layout: first three on top, last two on the centered
// bottom row (flex-wrap + centering does the 3/2 split).
const CARDS: CardDef[] = [
  {
    key: 'claude',
    name: 'Claude Code',
    description: "Anthropic's coding agent",
    icon: <ClaudeIcon size={28} />,
  },
  {
    key: 'codex',
    name: 'Codex',
    description: "OpenAI's coding agent",
    icon: <CodexIcon size={28} />,
  },
  {
    key: 'cursor',
    name: 'Cursor',
    description: "Cursor's coding agent",
    icon: <CursorIcon size={28} />,
  },
  {
    key: 'opencode',
    name: 'Opencode',
    description: 'Open-source coding agent',
    icon: <OpencodeIcon size={28} />,
  },
  {
    key: 'other',
    name: 'Other',
    description: 'Open a blank terminal',
    icon: <TerminalIcon size={28} />,
  },
];

/** Detected state of one agent pair, for the card badge. */
function detectionState(
  items: SetupItem[],
  key: AgentCardKey
): 'ready' | 'installed' | 'missing' | null {
  if (key === 'other') return null;
  const binary = items.find((i) => i.id === key);
  const auth = items.find((i) => i.id === `${key}_auth`);
  if (binary?.status === 'ready' && auth?.status === 'ready') return 'ready';
  if (binary?.status === 'ready') return 'installed';
  return 'missing';
}

const STATUS_LABELS: Record<'ready' | 'installed' | 'missing', string> = {
  ready: '✓ Ready',
  installed: 'Sign-in needed',
  missing: 'Not installed',
};

interface AgentPickGridProps {
  items: SetupItem[];
  onSelect: (key: AgentCardKey) => void;
  disabled?: boolean;
}

export function AgentPickGrid({ items, onSelect, disabled }: AgentPickGridProps) {
  return (
    <div className="agent-pick-grid" role="list">
      {CARDS.map((card) => {
        const state = detectionState(items, card.key);
        return (
          <button
            key={card.key}
            type="button"
            role="listitem"
            className={`agent-pick-card ${state === 'ready' ? 'detected-ready' : ''}`}
            onClick={() => onSelect(card.key)}
            disabled={disabled}
          >
            <span className="agent-pick-card-icon">{card.icon}</span>
            <span className="agent-pick-card-name">{card.name}</span>
            <span className="agent-pick-card-desc">{card.description}</span>
            {state && (
              <span className={`agent-pick-card-status ${state}`}>{STATUS_LABELS[state]}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
