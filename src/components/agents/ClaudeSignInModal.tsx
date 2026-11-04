/**
 * Claude Code's install and sign-in, run in a terminal over Agents: the same
 * commands the onboarding and the dashboard's Workspace accounts card run
 * (`TERMINAL_COMMANDS.claude`, then `claude auth login`). "Set up Claude
 * Code" installs and goes straight on to sign-in; an error line's "Sign in to
 * Claude Code" only signs in. Each step re-reads the agents overview, so the
 * composer unlocks in place as soon as Claude Code is there.
 *
 * @module components/agents/ClaudeSignInModal
 */

import { useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { OnboardingTerminal } from '../setup/OnboardingTerminal';
import { TERMINAL_COMMANDS } from '../../lib/setup';
import { refreshAgents } from '../../lib/agentsStore';

const TITLES = { install: 'Install Claude Code', 'sign-in': 'Sign in to Claude Code' } as const;

export function ClaudeSignInModal({
  start = 'sign-in',
  onClose,
}: {
  start?: keyof typeof TITLES;
  onClose: () => void;
}) {
  const [step, setStep] = useState(start);
  const command = TERMINAL_COMMANDS[step === 'install' ? 'claude' : 'claude_auth'];
  const done = () => {
    void refreshAgents();
    onClose();
  };
  return (
    <ModalFrame isOpen onClose={done} title={TITLES[step]} className="agents-panel-terminal-modal">
      <div className="agents-panel-terminal-body">
        <OnboardingTerminal
          key={step}
          command={command.command}
          args={command.args}
          onExit={(code) => {
            void refreshAgents();
            if (step === 'install' && code === 0) setStep('sign-in');
            else done();
          }}
        />
      </div>
    </ModalFrame>
  );
}
