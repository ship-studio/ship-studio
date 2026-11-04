/**
 * The model an agent runs on, as a quiet control in the chat header. Only
 * Claude Code's own aliases are offered; the change applies from its next turn.
 * Below it, what its routines run on: automatically Haiku while the agent is
 * on the default model, since a routine mostly checks and fires again and again.
 *
 * @module components/agents/AgentModelMenu
 */

import { CheckIcon, ChevronIcon } from '@/components/icons';
import { Dropdown, DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
import {
  AGENT_MODELS,
  ROUTINE_MODELS,
  modelLabel,
  routineModelOf,
  updateAgent,
  type Agent,
  type UpdateAgentInput,
} from '../../lib/agents';
import { refreshAgents } from '../../lib/agentsStore';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useOptionalToast } from '../../contexts/ToastContext';

export function AgentModelMenu({ agent }: { agent: Agent }) {
  const { showToast } = useOptionalToast();
  const current = agent.model ?? '';
  // "Default" alone reads as a setting with no subject in a chat header.
  const label = agent.model ? modelLabel(agent.model) : 'Default model';
  const routine = agent.routineModel ?? '';
  const save = async (change: UpdateAgentInput) => {
    try {
      await updateAgent(agent.id, change);
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
          tabIndex={0}
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
        <DropdownItem
          key={m.value}
          onSelect={() => m.value !== current && void save({ model: m.value })}
        >
          <span className="agent-model-menu__label">{m.label}</span>
          <span className="agent-model-menu__check" aria-hidden="true">
            {m.value === current && <CheckIcon size={12} />}
          </span>
        </DropdownItem>
      ))}
      <DropdownDivider />
      <p className="agent-model-menu__heading">
        Routines run on {modelLabel(routineModelOf(agent))}
      </p>
      {ROUTINE_MODELS.map((m) => (
        <DropdownItem
          key={m.value}
          onSelect={() => m.value !== routine && void save({ routineModel: m.value })}
        >
          <span className="agent-model-menu__label" title={m.hint ?? undefined}>
            {m.label}
          </span>
          <span className="agent-model-menu__check" aria-hidden="true">
            {m.value === routine && <CheckIcon size={12} />}
          </span>
        </DropdownItem>
      ))}
    </Dropdown>
  );
}
