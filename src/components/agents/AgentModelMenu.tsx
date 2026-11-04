/**
 * The model an agent runs on, as a quiet control in the chat header. Only
 * Claude Code's own aliases are offered; the change applies from its next turn.
 *
 * @module components/agents/AgentModelMenu
 */

import { ChevronIcon } from '@/components/icons';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
import { AGENT_MODELS, modelLabel, updateAgent, type Agent } from '../../lib/agents';
import { refreshAgents } from '../../lib/agentsStore';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useOptionalToast } from '../../contexts/ToastContext';

export function AgentModelMenu({ agent }: { agent: Agent }) {
  const { showToast } = useOptionalToast();
  const current = agent.model ?? '';
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
      trigger={(props) => (
        <MenuButton
          variant="ghost"
          size="compact"
          className="agent-chat__model"
          expanded={props['aria-expanded']}
          title="Model for its next turn"
          aria-label={`Model: ${modelLabel(agent.model)}`}
          {...props}
        >
          {modelLabel(agent.model)}
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
          active={m.value === current}
          onSelect={() => void choose(m.value)}
        >
          {m.label}
        </DropdownItem>
      ))}
    </Dropdown>
  );
}
