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
  getDefaultAgentId,
  setDefaultAgentId,
  isSetupItemReady,
  recheckWithDelays,
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
  AGENT_DOC_LINKS,
} from '../../lib/setup';
import { initDefaultAgent } from '../../lib/agent';
import { checkGitHubCliStatus } from '../../lib/github';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { withTimeout, TimeoutError } from '../../lib/withTimeout';
import { stripAnsi } from '../../lib/ansi';
import {
  detectAlreadyLoggedIn,
  extractTerminalError,
  isNetworkError,
  isNodeMissingError,
} from '../../lib/terminalDiagnostics';
import { openUrl } from '@tauri-apps/plugin-opener';
import { SlackIcon } from '../icons';

type OnboardingState = 'loading' | 'wizard' | 'complete';

/**
 * Cap on the setup-status check. The backend probes several binaries; if one
 * hangs the user would otherwise stare at "Checking setup status..." forever
 * (#173) — the timeout routes a hang into the existing error + Retry UI.
 */
const SETUP_STATUS_TIMEOUT_MS = 15_000;

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

/** Friendly tool names for auth items, used in already-signed-in messages. */
const AUTH_TOOL_LABELS: Record<string, string> = {
  claude_auth: 'Claude',
  codex_auth: 'Codex',
  opencode_auth: 'Opencode',
  gh_auth: 'GitHub',
};

/**
 * Message for the "CLI insists it's already signed in, but our status check
 * disagrees" case — e.g. a partial sign-out desynced `claude auth status`
 * from the checklist (issue #159). A generic "authentication not completed"
 * would be dishonest here; name the identity the CLI reported and point at
 * the real fix instead.
 */
function alreadySignedInMessage(itemId: string, identity: string | null): string {
  const tool = AUTH_TOOL_LABELS[itemId] ?? 'The CLI';
  const who = identity ? ` as ${identity}` : '';
  const fix =
    itemId === 'gh_auth'
      ? 'sign out by running `gh auth logout` in a terminal first'
      : 'sign out from the Agents panel first';
  return `${tool} reports you're already signed in${who} — if this looks wrong, ${fix}.`;
}

/**
 * Honest error for an auth item whose post-terminal verification failed:
 * prefer the already-signed-in special case, then whatever the terminal
 * actually said, over the generic message.
 */
function authFailureMessage(itemId: string, outputTail: string): string {
  const already = detectAlreadyLoggedIn(outputTail);
  if (already) return alreadySignedInMessage(itemId, already.identity);
  return extractTerminalError(outputTail) ?? 'Authentication not completed. Click to try again.';
}

/** Guidance shown when the output tail matches a network-failure signature. */
const NETWORK_FAILURE_MESSAGE =
  'This looks like a network problem — check your internet connection and try again.';

/**
 * Message for the "command exited cleanly but the tool never appeared" case —
 * e.g. the Homebrew installer's curl substitution coming back empty offline,
 * or the Windows winget informational echo (both exit 0 without installing
 * anything). A clean exit is a claim, not proof; this is what we say when
 * verification disproves it.
 */
function notDetectedMessage(itemId: string): string {
  const name = SETUP_FRIENDLY_NAMES[itemId] ?? itemId;
  return `The command finished but ${name} still isn't detected. If you're on a spotty connection, check your internet and try again.`;
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

  // The staggered post-exit re-checks (recheckWithDelays: 600/1500/3000ms)
  // outlive fast unmounts — their continuations must not dispatch state into
  // an unmounted tree (surfaced as a "window is not defined" teardown crash
  // in CI, and a setState-after-unmount warning in the app).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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

  // Compute completed steps: steps at or before the current one show as
  // completed once their items are ready (the current step earning its check
  // is real feedback); future steps stay unmarked to keep the path readable.
  const completedSteps = useMemo(() => {
    const set = new Set<WizardStepId>();
    const currentIndex = WIZARD_STEPS.findIndex((s) => s.id === currentStep);
    for (let i = 0; i < WIZARD_STEPS.length; i++) {
      const step = WIZARD_STEPS[i];
      if (i <= currentIndex && isWizardStepComplete(step.id, items)) {
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
      const status: FullSetupStatus = await withTimeout(
        getFullSetupStatus(),
        SETUP_STATUS_TIMEOUT_MS,
        'Setup status check'
      );
      // Callers reach here from delayed re-checks that can outlive the
      // wizard — never dispatch into an unmounted tree.
      if (!mountedRef.current) return status;
      setItems(status.items);
      setError(null);
      return status;
    } catch (err) {
      logger.warn('Failed to fetch setup status', { error: err });
      if (!mountedRef.current) return null;
      setError(
        err instanceof TimeoutError
          ? 'Setup check timed out — click Retry. If this persists, restart Ship Studio.'
          : 'Failed to check setup status. Please try again.'
      );
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
    } else if (status.detectedAgents.length > 1) {
      // Fast path with several agents skips the agent step's picker, and the
      // backend default falls back to claude-code even when Claude isn't one
      // of them. If the current default isn't actually installed, point it at
      // the first detected agent so the workspace opens with a working one.
      const currentDefault = (await getDefaultAgentId()) ?? 'claude-code';
      if (!status.detectedAgents.includes(currentDefault)) {
        const agentId = status.detectedAgents[0];
        await setDefaultAgentId(agentId);
        initDefaultAgent(agentId);
      }
    }
    // Fast-path users still need a setup_started for funnel completeness.
    fireSetupStartedOnce('fast_path', null);
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
    async (exitCode: number | null, outputTail = '') => {
      const itemId = terminalConfig?.itemId;
      if (!itemId) return;

      if (exitCode === 0 || exitCode === null) {
        setTerminalConfig(null);
        setTerminalExitCode(null);

        // A clean exit is a claim, not proof — e.g. an offline Homebrew
        // install exits 0 with nothing installed. Verify the outcome actually
        // landed, re-checking on a staggered schedule because auth/token files
        // and freshly installed binaries can appear a beat after the process
        // exits (same 600/1500/3000ms schedule as the dashboard AgentsPanel).
        let verified: boolean;
        if (itemId === 'gh_auth') {
          verified = await recheckWithDelays(
            async () => (await checkGitHubCliStatus()).authenticated
          );
        } else if (itemId === 'claude_auth') {
          verified = await recheckWithDelays(() => checkClaudeAuthStatus());
        } else {
          verified = await recheckWithDelays(async () => {
            try {
              const status = await withTimeout(
                getFullSetupStatus(),
                SETUP_STATUS_TIMEOUT_MS,
                'Setup status check'
              );
              return isSetupItemReady(status.items, itemId);
            } catch {
              return false;
            }
          });
        }

        // The re-checks above can span seconds — bail before touching state
        // if the wizard unmounted mid-wait.
        if (!mountedRef.current) return;

        // Sync the checklist with reality either way.
        await fetchStatus();
        if (!mountedRef.current) return;

        if (!verified) {
          void trackEvent('setup_action_failed', {
            item_id: itemId,
            exit_code: exitCode,
            error_excerpt: 'clean_exit_but_not_detected',
          });
          updateItemStatus(itemId, {
            status: 'error',
            errorMessage: itemId.endsWith('_auth')
              ? authFailureMessage(itemId, outputTail)
              : notDetectedMessage(itemId),
          });
        }
      } else {
        setTerminalExitCode(exitCode);

        // Surface the actual failure from the terminal output instead of a
        // generic message (issue #164 — installs failed with zero diagnostics).
        const extractedError = extractTerminalError(outputTail);
        const alreadySignedIn = itemId.endsWith('_auth') ? detectAlreadyLoggedIn(outputTail) : null;
        const networkMessage = isNetworkError(outputTail) ? NETWORK_FAILURE_MESSAGE : null;
        // Append guidance to the raw error, never replace it (standing rule:
        // verbose context beats tidy summaries — the raw line is what makes a
        // support screenshot diagnosable).
        let errorMessage =
          networkMessage && extractedError
            ? `${extractedError} — ${NETWORK_FAILURE_MESSAGE}`
            : (networkMessage ?? extractedError ?? 'Command failed. Click to try again.');
        if (itemId === 'homebrew') {
          // Only claim an admin-privileges problem when the output actually
          // points at one, or when nothing better was extracted — a blanket
          // admin hint masks the real error (e.g. a network failure).
          const mentionsPrivileges = /sudo|password|administrator/i.test(stripAnsi(outputTail));
          if (mentionsPrivileges || (!networkMessage && !extractedError)) {
            errorMessage =
              'Installation failed. Your macOS account may need administrator privileges.';
          }
        } else if (isNodeMissingError(outputTail)) {
          errorMessage =
            "Node.js/npm wasn't found. Complete the Node.js step first, or restart Ship Studio if you just installed it.";
        } else if (alreadySignedIn) {
          // Auth flow failed while the CLI insists it already has a login —
          // surface the disagreement instead of a misleading command error.
          errorMessage = alreadySignedInMessage(itemId, alreadySignedIn.identity);
        }
        void trackEvent('setup_action_failed', {
          item_id: itemId,
          exit_code: exitCode,
          error_excerpt: extractedError ?? undefined,
        });
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
      // was still completing when the user cancelled (e.g., gh/vercel/codex
      // writing the token after receiving the OAuth callback). Derived from
      // the `*_auth` convention so new auth flows get this for free.
      if (itemId.endsWith('_auth')) {
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
        // Tauri commands reject with a structured CommandError object (not an
        // Error instance), so `String(err)` would render "[object Object]".
        // Route through the shared helpers to get a real user-facing message.
        const errorMessage = formatCommandError(asCommandError(err));
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
    // Same in-flight guard as Next: navigating away mid-install/auth would
    // desync the active item's row from the terminal driving it.
    if (activeItemId || terminalConfig) return;
    const currentIndex = WIZARD_STEPS.findIndex((s) => s.id === currentStep);
    if (currentIndex > 0) {
      const prevStep = WIZARD_STEPS[currentIndex - 1].id;
      void trackEvent('setup_step_navigated_back', {
        from_step: currentStep,
        to_step: prevStep,
      });
      setCurrentStep(prevStep);
    }
  }, [currentStep, activeItemId, terminalConfig]);

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

  // Plain-language reason the Next button is disabled, so the user isn't left
  // staring at a greyed-out button with no idea what's still required.
  const nextBlockedReason = useMemo(() => {
    if (isNextEnabled) return null;
    if (activeItemId || terminalConfig) return null; // an action is mid-flight
    if (currentStep === 'agent') {
      if (!isAtLeastOneAgentReady(items)) return 'Connect at least one AI agent to continue';
      if (getReadyAgentPairs(items).length > 1 && !selectedAgentId) {
        return 'Choose your default agent to continue';
      }
    }
    const stepDef = WIZARD_STEPS.find((s) => s.id === currentStep);
    const blocker = stepDef?.itemIds
      .map((id) => items.find((it) => it.id === id))
      .find((it) => it !== undefined && it.status !== 'ready');
    if (blocker) {
      return `Finish setting up ${SETUP_FRIENDLY_NAMES[blocker.id] || blocker.id} to continue`;
    }
    return null;
  }, [isNextEnabled, activeItemId, terminalConfig, currentStep, items, selectedAgentId]);

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
    return (
      <CelebrationScreen
        onContinue={onComplete}
        hostingConnected={isWizardStepComplete('hosting', items)}
      />
    );
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
            <p className="wizard-step-subtitle">
              {/* Keep the subtitle text in its own node so the agent step can
                  append a "trouble installing?" hint with official-docs links. */}
              <span>{currentStepDef.subtitle}</span>
              {currentStep === 'agent' && (
                <>
                  {' — having trouble? Read the official docs ('}
                  {AGENT_DOC_LINKS.filter((doc) => items.some((i) => i.id === doc.binaryId)).map(
                    (doc, idx, arr) => (
                      <span key={doc.binaryId}>
                        <button
                          type="button"
                          className="wizard-step-subtitle-link"
                          onClick={() => void openUrl(doc.url)}
                        >
                          {doc.name}
                        </button>
                        {idx < arr.length - 1 ? ', ' : ''}
                      </span>
                    )
                  )}
                  {'), install it through your terminal, then restart Ship Studio.'}
                </>
              )}
            </p>
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
          {nextBlockedReason && <span className="wizard-nav-hint">{nextBlockedReason}</span>}
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
                onExit={(exitCode, outputTail) => void handleTerminalExit(exitCode, outputTail)}
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
