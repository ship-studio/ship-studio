/**
 * The model an agent runs on, as a quiet control in the chat header. Only
 * Claude Code's own aliases are offered; the change applies from its next turn.
 *
 * @module components/agents/AgentModelMenu
 */

import { CheckIcon, ChevronIcon } from '@/components/icons';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
import { AGENT_MODELS, modelLabel, updateAgent, type Agent } from '../../lib/agents';
import { refreshAgents } from '../../lib/agentsStore';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useOptionalToast } from '../../contexts/ToastContext';

export function AgentModelMenu({ agent }: { agent: Agent }) {
  const { showToast } = useOptionalToast();
  const current = agent.model ?? '';
  // "Default" alone reads as a setting with no subject in a chat header.
  const label = agent.model ? modelLabel(agent.model) : 'Default model';
  const choose = async (model: string) => {
    if (model === current) return;
    try {
      await updateAgent(agent.id, { model });
      await refreshAgents();
    } catch (error) {
      showToast(formatCommandError(asCommandError(error)), 'error');
    }
  };
  return (
    <Dropdown
      align="right"
      menuClassName="agent-model-menu"
      quietOpen
      trigger={(props) => (
        <MenuButton
          variant="ghost"
          className="agent-chat__model"
          expanded={props['aria-expanded']}
          title="Model for its next turn"
          aria-label={`Model: ${label}`}
          {...props}
        >
          {label}
          <ChevronIcon
            size={10}
            className={props['aria-expanded'] ? 'chevron-flipped' : undefined}
          />
        </MenuButton>
      )}
    >
      {AGENT_MODELS.map((m) => (
        <DropdownItem key={m.value} onSelect={() => void choose(m.value)}>
          <span className="agent-model-menu__label">{m.label}</span>
          <span className="agent-model-menu__check" aria-hidden="true">
            {m.value === current && <CheckIcon size={12} />}
          </span>
        </DropdownItem>
      ))}
    </Dropdown>
  );
}
