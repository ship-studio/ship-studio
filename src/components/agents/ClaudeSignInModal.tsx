/**
 * "Sign in to Claude Code" from an agent's error line: the same terminal
 * sign-in the dashboard's Workspace accounts card runs (`claude auth login`).
 *
 * @module components/agents/ClaudeSignInModal
 */

import { ModalFrame } from '../primitives/ModalFrame';
import { OnboardingTerminal } from '../setup/OnboardingTerminal';
import { TERMINAL_COMMANDS } from '../../lib/setup';
import { refreshAgents } from '../../lib/agentsStore';

export function ClaudeSignInModal({ onClose }: { onClose: () => void }) {
  const command = TERMINAL_COMMANDS.claude_auth;
  const done = () => {
    void refreshAgents();
    onClose();
  };
  return (
    <ModalFrame
      isOpen
      onClose={done}
      title="Sign in to Claude Code"
      className="agents-panel-terminal-modal"
    >
      <div className="agents-panel-terminal-body">
        <OnboardingTerminal command={command.command} args={command.args} onExit={done} />
      </div>
    </ModalFrame>
  );
}
