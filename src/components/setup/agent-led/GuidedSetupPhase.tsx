/**
 * Phase 1 of the agent-led onboarding: the chosen agent runs in a terminal
 * with a prescriptive setup prompt and installs everything the machine is
 * missing, while the checklist beside it verifies with the app's own checks.
 *
 * The agent drives; the app verifies. Completion is decided exclusively by
 * `isAgentLedSetupComplete` over freshly polled items — never by the agent
 * declaring success.
 *
 * `agentBinaryId: null` is the "Other" path: a plain shell opens instead of
 * a managed agent, with the guided prompt one Copy click away so the user
 * can launch whatever agent CLI they use and paste it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OnboardingTerminal } from '../OnboardingTerminal';
import { DemoAgentTerminal } from './DemoAgentTerminal';
import { SetupChecklist } from './SetupChecklist';
import { Button } from '../../primitives/Button';
import { SetupItem } from '../../../lib/setup';
import {
  buildGuidedSetupPrompt,
  ensureAgentWorkdir,
  getMissingRequiredItems,
  getReadyRequiredItems,
  guidedAgentSpawn,
  isAgentLedSetupComplete,
  otherAgentShellSpawn,
  HostChoice,
} from '../../../lib/agentOnboarding';
import { logger } from '../../../lib/logger';
import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard';
import { trackEvent } from '../../../lib/analytics';

interface GuidedSetupPhaseProps {
  /** Binary id of the chosen agent (e.g. "claude"), or null for "Other". */
  agentBinaryId: string | null;
  /** Display name of the chosen agent (e.g. "Claude Code" / "Your agent"). */
  agentDisplayName: string;
  /** Live setup items — the owner polls these while this phase is mounted. */
  items: SetupItem[];
  /** Hosting provider chosen in the hosting step (null = skipped). */
  hostChoice: HostChoice | null;
  /** Mock mode: play the scripted demo instead of spawning a real agent. */
  demoMode: boolean;
  /** Called when the user clicks Continue after everything is verified. */
  onVerified: () => void;
}

export function GuidedSetupPhase({
  agentBinaryId,
  agentDisplayName,
  items,
  hostChoice,
  demoMode,
  onVerified,
}: GuidedSetupPhaseProps) {
  // Freeze the missing list per agent session: the prompt describes the work
  // as it stood when the session started. A restart recomputes it, so an
  // agent relaunched after partial progress only gets the remaining items.
  const missingRef = useRef<SetupItem[] | null>(null);
  missingRef.current ??= getMissingRequiredItems(items);
  const readyRef = useRef<SetupItem[] | null>(null);
  readyRef.current ??= getReadyRequiredItems(items);
  const [session, setSession] = useState(0);
  const [agentExit, setAgentExit] = useState<number | null>(null);
  const { copy, isCopied } = useCopyToClipboard();

  // Spawn the agent in ~/ShipStudio, never $HOME — scanning the home folder
  // trips macOS permission prompts (Photos/Desktop/Documents) attributed to
  // Ship Studio, and the pending dialog freezes the agent mid-scan. The
  // backend falls back to the OS temp dir on its own, so a rejection here
  // means the IPC call itself failed — retry once rather than ever spawning
  // in $HOME. `null` = still resolving (terminal not rendered yet).
  const [workdir, setWorkdir] = useState<string | null>(null);
  useEffect(() => {
    ensureAgentWorkdir()
      .catch(() => ensureAgentWorkdir())
      .then(setWorkdir)
      .catch((err: unknown) => {
        logger.error('Could not prepare an agent working folder', {
          error: String(err),
        });
      });
  }, []);

  const isOther = agentBinaryId === null;
  const complete = isAgentLedSetupComplete(items, agentBinaryId);

  const prompt = useMemo(
    () => buildGuidedSetupPrompt(missingRef.current ?? [], hostChoice, readyRef.current ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, hostChoice]
  );
  const spawn = useMemo(
    () => (isOther ? otherAgentShellSpawn() : guidedAgentSpawn(agentBinaryId, prompt)),
    [isOther, agentBinaryId, prompt]
  );

  const handleAgentExit = useCallback((exitCode: number | null) => {
    setAgentExit(exitCode ?? 0);
  }, []);

  const handleRestart = useCallback(() => {
    missingRef.current = null; // recompute from current items on next render
    readyRef.current = null;
    setAgentExit(null);
    setSession((s) => s + 1);
    void trackEvent('agent_guided_setup_restarted', { agent_id: agentBinaryId ?? 'other' });
  }, [agentBinaryId]);

  return (
    <div className="agent-guided-phase">
      <div className="agent-guided-header">
        <h2 className="wizard-step-title">
          {complete
            ? 'Everything is set up and verified'
            : isOther
              ? 'Launch your agent to finish setup'
              : `${agentDisplayName} is setting you up`}
        </h2>
        <p className="wizard-step-subtitle">
          {complete
            ? 'All checks passed — you’re ready to start building.'
            : isOther
              ? 'Start your agent in this terminal, then paste the setup instructions below into it.'
              : 'Follow along in the terminal — your agent explains each step and will tell you if it needs anything (like a password or a browser sign-in).'}
        </p>
      </div>

      {isOther && !complete && !demoMode && (
        <div className="agent-guided-prompt-bar">
          <span>Setup instructions for your agent:</span>
          <Button variant="secondary" onClick={() => void copy(prompt)}>
            {isCopied ? 'Copied!' : 'Copy instructions'}
          </Button>
        </div>
      )}

      <div className="agent-guided-layout">
        <div className="agent-guided-terminal">
          {demoMode ? (
            <DemoAgentTerminal hostChoice={hostChoice} />
          ) : workdir !== null ? (
            <OnboardingTerminal
              key={session}
              command={spawn.command}
              args={spawn.args}
              cwd={workdir}
              onExit={handleAgentExit}
            />
          ) : null}
          {!complete && agentExit !== null && !demoMode && (
            <div className="agent-guided-exit-notice">
              <span>
                {isOther
                  ? 'The terminal session ended before setup finished.'
                  : 'The agent session ended before setup finished.'}
              </span>
              <Button variant="secondary" onClick={handleRestart}>
                {isOther ? 'Reopen terminal' : 'Restart the agent'}
              </Button>
            </div>
          )}
        </div>

        <div className="agent-guided-sidebar">
          <SetupChecklist
            items={items}
            agentBinaryId={agentBinaryId}
            agentDisplayName={agentDisplayName}
            hostChoice={hostChoice}
          />
          {complete && (
            <div className="agent-guided-complete">
              <p>Every check passed — verified by Ship Studio itself, not just the agent.</p>
              <Button variant="primary" block onClick={onVerified}>
                Continue
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
