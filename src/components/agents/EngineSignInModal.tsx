/**
 * An engine's install and sign-in, run in a terminal over Agents: the same
 * commands the onboarding and the dashboard's Workspace accounts card run
 * (`TERMINAL_COMMANDS.claude` then `claude auth login`, or `codex` then
 * `codex login`). "Set up Claude Code" installs and goes straight on to
 * sign-in; an error line's "Sign in to …" only signs in. Each step re-reads
 * the agents overview, so the composer unlocks in place as soon as the engine
 * is there.
 *
 * @module components/agents/EngineSignInModal
 */

import { useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { OnboardingTerminal } from '../setup/OnboardingTerminal';
import { TERMINAL_COMMANDS } from '../../lib/setup';
import { refreshAgents } from '../../lib/agentsStore';
import { ENGINE_LABEL, type AgentEngine } from '../../lib/agents';

export type EngineStep = 'install' | 'sign-in';

/** Which engine, and where to start. */
export interface EngineSetup {
  engine: AgentEngine;
  step: EngineStep;
}

const COMMANDS: Record<AgentEngine, Record<EngineStep, string>> = {
  claude: { install: 'claude', 'sign-in': 'claude_auth' },
  codex: { install: 'codex', 'sign-in': 'codex_auth' },
};

export function EngineSignInModal({
  engine,
  step: start,
  onClose,
}: EngineSetup & { onClose: () => void }) {
  const [step, setStep] = useState(start);
  const command = TERMINAL_COMMANDS[COMMANDS[engine][step]];
  const title = `${step === 'install' ? 'Install' : 'Sign in to'} ${ENGINE_LABEL[engine]}`;
  const done = () => {
    void refreshAgents();
    onClose();
  };
  return (
    <ModalFrame isOpen onClose={done} title={title} className="agents-panel-terminal-modal">
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
