/**
 * Main onboarding screen that orchestrates the step-by-step setup wizard.
 *
 * Handles:
 * - Fetching and displaying setup status
 * - Navigating between wizard steps (auto-advances past completed steps)
 * - Triggering installations and authentications
 * - Embedded terminal for interactive CLI commands
 * - Transitioning to celebration screen when complete
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { WizardStepIndicator } from './WizardStepIndicator';
import { PackageManagerStep } from './steps/PackageManagerStep';
import { GitGitHubStep } from './steps/GitGitHubStep';
import { AgentStep } from './steps/AgentStep';
import { HostingStep } from './steps/HostingStep';
import { CelebrationScreen } from './CelebrationScreen';
import { OnboardingTerminal } from './OnboardingTerminal';
import { trackEvent, trackPageview } from '../../lib/analytics';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { logger } from '../../lib/logger';
import {
  SetupItem,
  FullSetupStatus,
  getFullSetupStatus,
  checkClaudeAuthStatus,
  installPackages,
  setDefaultAgentId,
  PKG_MGR_PACKAGES,
  TERMINAL_COMMANDS,
  USES_TERMINAL,
  SETUP_FRIENDLY_NAMES,
  WIZARD_STEPS,
  WizardStepId,
  isWizardStepComplete,
  findFirstIncompleteStep,
  getReadyAgentPairs,
  isAtLeastOneAgentReady,
} from '../../lib/setup';
import { initDefaultAgent } from '../../lib/agent';
import { checkGitHubCliStatus } from '../../lib/github';
import { openUrl } from '@tauri-apps/plugin-opener';
import { SlackIcon } from '../icons';

type OnboardingState = 'loading' | 'wizard' | 'complete';

// Module-scoped so React 18 StrictMode's mount→unmount→remount in dev doesn't
// re-fire `setup_started` after the first launch of this app session. Each
// app process gets a fresh module load, so this is naturally session-scoped.
let setupStartedFiredThisSession = false;
function fireSetupStartedOnce(entryPath: 'wizard' | 'fast_path', entryStep: WizardStepId | null) {
  if (setupStartedFiredThisSession) return;
  setupStartedFiredThisSession = true;
  void trackEvent('setup_started', { entry_path: entryPath, entry_step: entryStep });
}

/** Configuration for the active terminal command */
interface TerminalConfig {
  itemId: string;
  command: string;
  args: string[];
}

interface OnboardingScreenProps {
  /** Called when setup is complete and user continues */
  onComplete: () => void;
}

export function OnboardingScreen({ onComplete }: OnboardingScreenProps) {
  const [state, setState] = useState<OnboardingState>('loading');
  const [currentStep, setCurrentStep] = useState<WizardStepId>('package-manager');
  const [items, setItems] = useState<SetupItem[]>([]);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [terminalConfig, setTerminalConfig] = useState<TerminalConfig | null>(null);
  const [terminalExitCode, setTerminalExitCode] = useState<number | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const stepEnteredAtRef = useRef<Map<WizardStepId, number>>(new Map());

  // Track each step entry: pageview, setup_step_entered, and remember when
  // we entered so the completion event can carry duration_ms.
  useEffect(() => {
    if (state !== 'wizard') return;
    const stepIndex = WIZARD_STEPS.findIndex((s) => s.id === currentStep);
    const stepDef = WIZARD_STEPS[stepIndex];
    if (!stepDef) return;
    fireSetupStartedOnce('wizard', currentStep);
    trackPageview(`Onboarding - ${stepDef.title}`);
    void trackEvent('setup_step_entered', {
      step_id: currentStep,
      step_index: stepIndex,
    });
    stepEnteredAtRef.current.set(currentStep, performance.now());
  }, [state, currentStep]);

  // Compute completed steps: only show as completed if before the current step
  const completedSteps = useMemo(() => {
    const set = new Set<WizardStepId>();
    const currentIndex = WIZARD_STEPS.findIndex((s) => s.id === currentStep);
    for (let i = 0; i < WIZARD_STEPS.length; i++) {
      const step = WIZARD_STEPS[i];
      if (i < currentIndex && isWizardStepComplete(step.id, items)) {
        set.add(step.id);
      }
    }
    return set;
  }, [items, currentStep]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current();
      }
    };
  }, []);

  // Fetch initial status and determine starting step
  const fetchStatus = useCallback(async () => {
    try {
      const status: FullSetupStatus = await getFullSetupStatus();
      setItems(status.items);
      setError(null);
      return status;
    } catch {
      logger.warn('Failed to fetch setup status');
      setError('Failed to check setup status. Please try again.');
      setState('wizard');
      return null;
    }
  }, []);

  // Initial fetch — determine which step to start on
  useEffect(() => {
    const init = async () => {
      const status = await fetchStatus();
      if (!status) return;

      const firstIncomplete = findFirstIncompleteStep(status.items);
      if (firstIncomplete === null) {
        // All steps complete — handle agent default and go to celebration
        await handleAllComplete(status);
      } else {
        setCurrentStep(firstIncomplete);
        setState('wizard');
      }
    };
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for setup progress events
  useEffect(() => {
    const setupListener = async () => {
      unlistenRef.current = await listen<{ itemId: string; message: string }>(
        'setup-progress',
        (event) => {
          logger.info('Setup progress', {
            itemId: event.payload.itemId,
            message: event.payload.message,
          });
        }
      );
    };
    void setupListener();
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current();
      }
    };
  }, []);

  // Handle all-complete: set default agent and transition to celebration
  const handleAllComplete = useCallback(async (status: FullSetupStatus) => {
    if (status.detectedAgents.length === 1) {
      const agentId = status.detectedAgents[0];
      await setDefaultAgentId(agentId);
      initDefaultAgent(agentId);
    }
    // Fast-path users still need a setup_started for funnel completeness.
    fireSetupStartedOnce('fast_path', null);
    // If multiple agents, they'll be asked to pick in the agent step
    void trackEvent('onboarding_completed', {
      agents: status.detectedAgents,
      entry_path: 'fast_path',
      $screen_name: 'Onboarding',
    });
    setState('complete');
  }, []);

  // Update a single item's status
  const updateItemStatus = useCallback((itemId: string, updates: Partial<SetupItem>) => {
    setItems((prev) => prev.map((item) => (item.id === itemId ? { ...item, ...updates } : item)));
  }, []);

  // Handle terminal exit - process exit codes and check auth status
  const handleTerminalExit = useCallback(
    async (exitCode: number | null) => {
      const itemId = terminalConfig?.itemId;
      if (!itemId) return;

      if (exitCode === 0 || exitCode === null) {
        setTerminalConfig(null);
        setTerminalExitCode(null);

        // For auth items, verify the auth status
        if (itemId === 'gh_auth') {
          const status = await checkGitHubCliStatus();
          if (!status.authenticated) {
            updateItemStatus(itemId, {
              status: 'error',
              errorMessage: 'Authentication not completed. Click to try again.',
            });
            setActiveItemId(null);
            return;
          }
        } else if (itemId === 'claude_auth') {
          const isAuthed = await checkClaudeAuthStatus();
          if (!isAuthed) {
            updateItemStatus(itemId, {
              status: 'error',
              errorMessage: 'Authentication not completed. Click to try again.',
            });
            setActiveItemId(null);
            return;
          }
        }

        // Refresh full status
        await fetchStatus();
      } else {
        setTerminalExitCode(exitCode);

        let errorMessage = 'Command failed. Click to try again.';
        if (itemId === 'homebrew') {
          errorMessage =
            'Installation failed. Your macOS account may need administrator privileges.';
        }
        updateItemStatus(itemId, {
          status: 'error',
          errorMessage,
        });
      }

      setActiveItemId(null);
    },
    [terminalConfig, fetchStatus, updateItemStatus]
  );

  // Handle terminal cancel/close
  const handleTerminalCancel = useCallback(() => {
    const itemId = terminalConfig?.itemId;
    setTerminalConfig(null);
    setTerminalExitCode(null);
    setActiveItemId(null);

    if (itemId && !terminalExitCode) {
      // Refresh status immediately
      void fetchStatus();
      // For auth items, do a delayed re-check in case the auth process
      // was still completing when the user cancelled (e.g., gh/vercel
      // writing the token after receiving the OAuth callback)
      if (itemId === 'gh_auth' || itemId === 'vercel_auth' || itemId === 'claude_auth') {
        setTimeout(() => void fetchStatus(), 2000);
      }
    }
  }, [terminalConfig, terminalExitCode, fetchStatus]);

  // Handle item action (install or connect)
  const handleItemAction = useCallback(
    async (itemId: string) => {
      if (activeItemId || terminalConfig) return;

      // Auth items are "connect"; everything else is "install". Derive from
      // the convention (`*_auth` suffix) so adding a new auth flow doesn't
      // require remembering to update this list.
      const isAuth = itemId.endsWith('_auth');
      void trackEvent('setup_action_clicked', {
        item_id: itemId,
        action: isAuth ? 'connect' : 'install',
        step_id: currentStep,
      });

      setActiveItemId(itemId);
      updateItemStatus(itemId, { status: 'in_progress', errorMessage: undefined });

      // For auth items, re-check status first — the user may have already
      // completed auth (e.g., in a previous cancelled terminal session) but
      // the checklist didn't update. This also serves as a "refresh" mechanism.
      if (itemId === 'gh_auth') {
        const status = await checkGitHubCliStatus();
        if (status.authenticated) {
          await fetchStatus();
          setActiveItemId(null);
          return;
        }
      } else if (itemId === 'claude_auth') {
        const isAuthed = await checkClaudeAuthStatus();
        if (isAuthed) {
          await fetchStatus();
          setActiveItemId(null);
          return;
        }
      }

      // Check if this item uses terminal
      if (USES_TERMINAL.has(itemId)) {
        const cmd = TERMINAL_COMMANDS[itemId];
        if (cmd) {
          setTerminalConfig({
            itemId,
            command: cmd.command,
            args: cmd.args,
          });
          return;
        }
      }

      // Non-terminal items - run via backend
      try {
        if (PKG_MGR_PACKAGES.has(itemId)) {
          const missingPackages = items
            .filter((item) => PKG_MGR_PACKAGES.has(item.id) && item.status !== 'ready')
            .map((item) => item.id);

          for (const pkgId of missingPackages) {
            if (pkgId !== itemId) {
              updateItemStatus(pkgId, { status: 'in_progress', errorMessage: undefined });
            }
          }

          await installPackages(missingPackages);
        } else {
          logger.warn(`Unknown item: ${itemId}`);
        }

        await fetchStatus();
        setActiveItemId(null);
      } catch (err) {
        logger.warn(`Failed to process ${itemId}`);
        const errorMessage = err instanceof Error ? err.message : String(err);
        const cleanedMessage = errorMessage.replace(/\[[\w_]+\]\s*/g, '').trim();

        if (PKG_MGR_PACKAGES.has(itemId)) {
          // Use functional updater to read the latest items state
          // (the closure `items` may be stale after async operations)
          setItems((prev) =>
            prev.map((item) => {
              if (PKG_MGR_PACKAGES.has(item.id) && item.status === 'in_progress') {
                return {
                  ...item,
                  status: 'error' as const,
                  errorMessage: cleanedMessage || 'Something went wrong. Click to try again.',
                };
              }
              return item;
            })
          );
        } else {
          updateItemStatus(itemId, {
            status: 'error',
            errorMessage: cleanedMessage || 'Something went wrong. Click to try again.',
          });
        }
        setActiveItemId(null);
      }
    },
    [activeItemId, terminalConfig, updateItemStatus, fetchStatus, items, currentStep]
  );

  // Emit setup_step_completed for the step the user just clicked Next on.
  // Only fires from handleNext — the all-complete fast path skips the wizard
  // entirely and never enters any step, so a per-step completion event there
  // would be a fabrication.
  const fireStepCompleted = useCallback((stepId: WizardStepId, isFinal: boolean) => {
    const enteredAt = stepEnteredAtRef.current.get(stepId);
    void trackEvent('setup_step_completed', {
      step_id: stepId,
      step_index: WIZARD_STEPS.findIndex((s) => s.id === stepId),
      duration_ms: enteredAt !== undefined ? Math.round(performance.now() - enteredAt) : null,
      is_final: isFinal,
    });
  }, []);

  // Navigate to the next incomplete step
  const handleNext = useCallback(async () => {
    const currentIndex = WIZARD_STEPS.findIndex((s) => s.id === currentStep);

    // On the agent step, if multiple agents are ready and no default selected yet, require selection
    if (currentStep === 'agent') {
      const readyPairs = getReadyAgentPairs(items);
      if (readyPairs.length > 1 && !selectedAgentId) {
        // Don't advance — user needs to pick a default
        return;
      }
      // Set the default agent
      if (readyPairs.length > 1 && selectedAgentId) {
        await setDefaultAgentId(selectedAgentId);
        initDefaultAgent(selectedAgentId);
        void trackEvent('default_agent_selected', {
          agent_id: selectedAgentId,
          agent_count: readyPairs.length,
          $screen_name: 'Onboarding',
        });
      } else if (readyPairs.length === 1) {
        const agentId =
          readyPairs[0].binaryId === 'claude' ? 'claude-code' : readyPairs[0].binaryId;
        await setDefaultAgentId(agentId);
        initDefaultAgent(agentId);
      }
    }

    // Find next incomplete step after current. Anything between current and
    // the target is auto-skipped because it's already complete; emit a
    // setup_step_skipped event for each so the funnel shows where the user
    // breezed through vs. where they actually stopped.
    for (let i = currentIndex + 1; i < WIZARD_STEPS.length; i++) {
      const step = WIZARD_STEPS[i];
      if (!isWizardStepComplete(step.id, items)) {
        fireStepCompleted(currentStep, false);
        for (let j = currentIndex + 1; j < i; j++) {
          const skipped = WIZARD_STEPS[j];
          void trackEvent('setup_step_skipped', {
            step_id: skipped.id,
            step_index: j,
            reason: 'already_complete',
          });
        }
        setCurrentStep(step.id);
        return;
      }
    }

    // All steps after current are complete → celebration. Emit skipped
    // events for each intermediate so the funnel terminates cleanly.
    fireStepCompleted(currentStep, true);
    for (let j = currentIndex + 1; j < WIZARD_STEPS.length; j++) {
      const skipped = WIZARD_STEPS[j];
      void trackEvent('setup_step_skipped', {
        step_id: skipped.id,
        step_index: j,
        reason: 'already_complete',
      });
    }
    setState('complete');
  }, [currentStep, items, selectedAgentId, fireStepCompleted]);

  // Navigate to the previous step
  const handleBack = useCallback(() => {
    const currentIndex = WIZARD_STEPS.findIndex((s) => s.id === currentStep);
    if (currentIndex > 0) {
      const prevStep = WIZARD_STEPS[currentIndex - 1].id;
      void trackEvent('setup_step_navigated_back', {
        from_step: currentStep,
        to_step: prevStep,
      });
      setCurrentStep(prevStep);
    }
  }, [currentStep]);

  // Check if Next button should be enabled
  const isNextEnabled = useMemo(() => {
    if (activeItemId || terminalConfig) return false;

    if (currentStep === 'hosting') return true; // Always passable

    if (currentStep === 'agent') {
      if (!isAtLeastOneAgentReady(items)) return false;
      const readyPairs = getReadyAgentPairs(items);
      if (readyPairs.length > 1 && !selectedAgentId) return false;
      return true;
    }

    return isWizardStepComplete(currentStep, items);
  }, [currentStep, items, activeItemId, terminalConfig, selectedAgentId]);

  // Get current step definition
  const currentStepDef = WIZARD_STEPS.find((s) => s.id === currentStep)!;
  const currentStepIndex = WIZARD_STEPS.findIndex((s) => s.id === currentStep);
  const isFirstStep = currentStepIndex === 0;
  const isLastStep = currentStepIndex === WIZARD_STEPS.length - 1;

  if (state === 'loading') {
    return (
      <div className="onboarding-screen onboarding-loading">
        <Spinner size="lg" style={{ color: 'var(--text-muted)' }} />
        <p>Checking setup status...</p>
      </div>
    );
  }

  if (state === 'complete') {
    return <CelebrationScreen onContinue={onComplete} />;
  }

  return (
    <div className="onboarding-screen">
      <div className="onboarding-content">
        <div className="onboarding-header">
          <img src="/ship_studio_full_noshadow.svg" alt="Ship Studio" className="onboarding-logo" />
          <h1>Quick Setup</h1>
          <p className="onboarding-reassurance">
            Most users finish in under 3 minutes. Let's get you ready to ship.
          </p>
        </div>

        {error && (
          <div className="onboarding-error">
            <p>{error}</p>
            <Button variant="secondary" onClick={() => void fetchStatus()}>
              Retry
            </Button>
          </div>
        )}

        <WizardStepIndicator currentStep={currentStep} completedSteps={completedSteps} />

        <div className="wizard-step-container">
          <div className="wizard-step-header">
            <h2 className="wizard-step-title">{currentStepDef.title}</h2>
            <p className="wizard-step-subtitle">{currentStepDef.subtitle}</p>
          </div>

          {currentStep === 'package-manager' && (
            <PackageManagerStep
              items={items}
              onItemAction={(id) => void handleItemAction(id)}
              activeItemId={activeItemId}
              terminalActive={terminalConfig !== null}
            />
          )}

          {currentStep === 'git-github' && (
            <GitGitHubStep
              items={items}
              onItemAction={(id) => void handleItemAction(id)}
              activeItemId={activeItemId}
              terminalActive={terminalConfig !== null}
            />
          )}

          {currentStep === 'agent' && (
            <AgentStep
              items={items}
              onItemAction={(id) => void handleItemAction(id)}
              activeItemId={activeItemId}
              terminalActive={terminalConfig !== null}
              onAgentSelect={setSelectedAgentId}
              selectedAgentId={selectedAgentId}
            />
          )}

          {currentStep === 'hosting' && (
            <HostingStep
              items={items}
              onItemAction={(id) => void handleItemAction(id)}
              activeItemId={activeItemId}
              terminalActive={terminalConfig !== null}
              onSkip={() => void handleNext()}
            />
          )}
        </div>

        {/* Navigation buttons */}
        <div className="wizard-nav">
          {!isFirstStep && (
            <button className="wizard-nav-back" onClick={handleBack}>
              Back
            </button>
          )}
          <div className="wizard-nav-spacer" />
          <button
            className="wizard-nav-next"
            onClick={() => void handleNext()}
            disabled={!isNextEnabled}
          >
            {isLastStep ? 'Finish' : 'Next'}
          </button>
        </div>

        {/* Terminal modal for interactive commands */}
        {terminalConfig && (
          <div className="onboarding-terminal-overlay">
            <div className="onboarding-terminal-modal">
              <div className="onboarding-terminal-header">
                <span className="onboarding-terminal-title">
                  {SETUP_FRIENDLY_NAMES[terminalConfig.itemId] || terminalConfig.itemId}
                </span>
                <button className="onboarding-terminal-cancel" onClick={handleTerminalCancel}>
                  {terminalExitCode ? 'Close' : 'Cancel'}
                </button>
              </div>
              <OnboardingTerminal
                command={terminalConfig.command}
                args={terminalConfig.args}
                onExit={(exitCode) => void handleTerminalExit(exitCode)}
              />
              <div className="onboarding-terminal-hint">
                <strong>If you're asked for a password</strong>, type it and press Enter. It stays
                hidden as you type — no dots or characters appear — but it is being entered.
              </div>
            </div>
          </div>
        )}

        <div className="onboarding-slack-cta">
          <SlackIcon size={18} />
          <span>
            <strong>Having problems getting set up?</strong> Join the Slack channel and we'll help
            you out!
          </span>
          <button
            onClick={() =>
              void openUrl(
                'https://join.slack.com/t/shipstudiocommunity/shared_invite/zt-41vbyaoo0-_pZWNPyMdvMoF6neuDYw7g'
              )
            }
          >
            Join Slack
          </button>
        </div>
      </div>
    </div>
  );
}
