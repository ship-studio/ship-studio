/**
 * Agent-led onboarding orchestrator.
 *
 * Inverts the classic wizard: Phase 0 gets exactly one AI agent installed and
 * signed in (the only part that can't be agent-led), then Phase 1 hands the
 * wheel to that agent to install everything else while the app verifies with
 * its own checks. The classic wizard remains one click away at all times via
 * the router's corner button.
 *
 * States: loading → pick (grid → per-agent detail) → guided → complete.
 * "Other" skips agent management entirely: it opens a plain terminal for any
 * agent CLI we don't manage, records the external-agent opt-in so setup
 * checks don't bounce the user back, and defaults the workspace to the
 * Terminal agent. Machines that are already fully set up fast-path to
 * complete — except under SHIPSTUDIO_FORCE_ONBOARDING, where the pick phase
 * is always shown so the flow can be eyeballed on a dev machine.
 */

import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { CelebrationScreen } from '../CelebrationScreen';
import { OnboardingTerminal } from '../OnboardingTerminal';
import { AgentPickGrid, AgentCardKey } from './AgentPickGrid';
import { AgentSetupDetail } from './AgentSetupDetail';
import { HostingPickGrid } from './HostingPickGrid';
import { GuidedSetupPhase } from './GuidedSetupPhase';
import { useAgentSetupActions } from './useAgentSetupActions';
import { Button } from '../../primitives/Button';
import { Spinner } from '../../primitives/Spinner';
import {
  SetupItem,
  FullSetupStatus,
  getFullSetupStatus,
  getReadyAgentPairs,
  setDefaultAgentId,
  SETUP_FRIENDLY_NAMES,
} from '../../../lib/setup';
import {
  getMissingRequiredItems,
  getOnboardingTestMode,
  isAgentLedSetupComplete,
  setDefaultHost,
  setExternalAgentOptIn,
  HostChoice,
  OnboardingTestMode,
} from '../../../lib/agentOnboarding';
import { initDefaultAgent, getAgentById } from '../../../lib/agent';
import { ClaudeIcon, CodexIcon, CursorIcon, OpencodeIcon } from '@/components/icons';
import { usePolling } from '../../../hooks/usePolling';
import { withTimeout, TimeoutError } from '../../../lib/withTimeout';
import { trackEvent, setActiveScreen } from '../../../lib/analytics';
import { logger } from '../../../lib/logger';

type Phase = 'loading' | 'pick' | 'hosting' | 'guided' | 'complete';

const SETUP_STATUS_TIMEOUT_MS = 15_000;

// Session-scoped guard mirroring the classic wizard's setup_started dedupe
// (module scope survives StrictMode remounts, resets per app process).
let agentSetupStartedFired = false;

/** Agent-config id for a setup pair's binary id (claude → claude-code). */
function agentIdForBinary(binaryId: string): string {
  return binaryId === 'claude' ? 'claude-code' : binaryId;
}

const DETAIL_ICONS: Record<string, ReactNode> = {
  claude: <ClaudeIcon size={28} />,
  codex: <CodexIcon size={28} />,
  cursor: <CursorIcon size={28} />,
  opencode: <OpencodeIcon size={28} />,
};

interface AgentOnboardingScreenProps {
  /** Called when setup is complete and the user continues. */
  onComplete: () => void;
}

export function AgentOnboardingScreen({ onComplete }: AgentOnboardingScreenProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [items, setItems] = useState<SetupItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Agent card being set up in the detail view (grid shown when null). */
  const [detailAgent, setDetailAgent] = useState<AgentCardKey | null>(null);
  /** The committed choice driving the guided phase; 'other' = BYO agent. */
  const [chosenKey, setChosenKey] = useState<AgentCardKey | null>(null);
  /** Hosting provider chosen in the hosting step (null = skipped). */
  const [hostChoice, setHostChoice] = useState<HostChoice | null>(null);
  const [testMode, setTestMode] = useState<OnboardingTestMode>({
    mock: false,
    forceOnboarding: false,
  });

  const chosenBinaryId = chosenKey === 'other' ? null : chosenKey;

  const fetchStatus = useCallback(async (): Promise<FullSetupStatus | null> => {
    try {
      const status = await withTimeout(
        getFullSetupStatus(),
        SETUP_STATUS_TIMEOUT_MS,
        'Setup status check'
      );
      setItems(status.items);
      setError(null);
      return status;
    } catch (err) {
      logger.warn('Agent onboarding: failed to fetch setup status', { error: err });
      setError(
        err instanceof TimeoutError
          ? 'Setup check timed out — click Retry. If this persists, restart Ship Studio.'
          : 'Failed to check setup status. Please try again.'
      );
      return null;
    }
  }, []);

  const updateItemStatus = useCallback((itemId: string, updates: Partial<SetupItem>) => {
    setItems((prev) => prev.map((item) => (item.id === itemId ? { ...item, ...updates } : item)));
  }, []);

  const actions = useAgentSetupActions({ fetchStatus, updateItemStatus, mock: testMode.mock });

  const fireCompleted = useCallback((agents: string[], entryPath: string) => {
    void trackEvent('onboarding_completed', {
      agents,
      entry_path: entryPath,
      $screen_name: 'Onboarding',
    });
  }, []);

  /** Commit a ready agent, then ask about hosting before the guided phase. */
  const proceedWithAgent = useCallback(async (binaryId: string) => {
    const agentId = agentIdForBinary(binaryId);
    await setDefaultAgentId(agentId);
    initDefaultAgent(agentId);
    setChosenKey(binaryId as AgentCardKey);
    setDetailAgent(null);
    setActiveScreen('Onboarding - Hosting Pick');
    setPhase('hosting');
  }, []);

  /** "Other": bring-your-own agent — plain terminal, external-agent opt-in. */
  const proceedWithOther = useCallback(async () => {
    setChosenKey('other');
    setDetailAgent(null);
    // Persist both sides of the choice up front: the workspace opens with
    // the plain Terminal agent, and setup checks stop requiring a managed
    // agent so this user isn't bounced back to onboarding on relaunch.
    await setDefaultAgentId('terminal');
    initDefaultAgent('terminal');
    await setExternalAgentOptIn(true).catch((err: unknown) => {
      logger.warn('Failed to persist external agent opt-in', { error: String(err) });
    });
    setActiveScreen('Onboarding - Hosting Pick');
    setPhase('hosting');
  }, []);

  /**
   * Hosting decided (or skipped) — now route to the guided phase, or straight
   * to celebration when there is genuinely nothing left to set up. Cloudflare
   * has no backend detection yet, so choosing it always runs the guided phase.
   */
  const handleHostDecision = useCallback(
    async (host: HostChoice | null) => {
      setHostChoice(host);
      void trackEvent('onboarding_host_selected', { host: host ?? 'skipped' });
      if (host) {
        await setDefaultHost(host).catch((err: unknown) => {
          logger.warn('Failed to persist default host', { error: String(err) });
        });
      }

      const agentId = chosenKey === 'other' || !chosenKey ? 'other' : agentIdForBinary(chosenKey);
      const missing = getMissingRequiredItems(items);
      const vercelReady =
        items.find((i) => i.id === 'vercel')?.status === 'ready' &&
        items.find((i) => i.id === 'vercel_auth')?.status === 'ready';
      const hostNeedsSetup =
        host === 'cloudflare' ? true : host === 'vercel' ? !vercelReady : false;

      // Under SHIPSTUDIO_FORCE_ONBOARDING the guided phase always runs, even
      // with nothing missing — the real agent gets a verify-only prompt and
      // confirms the installed tools. This is how the agent interaction is
      // tested for real on a fully set-up dev machine.
      if (missing.length === 0 && !hostNeedsSetup && !testMode.forceOnboarding) {
        fireCompleted([agentId], 'agent_led');
        setPhase('complete');
        return;
      }
      void trackEvent('agent_guided_setup_started', {
        agent_id: agentId,
        missing_items: missing.map((i) => i.id),
        host: host ?? 'skipped',
        demo: testMode.mock,
      });
      setActiveScreen('Onboarding - Agent Guided Setup');
      setPhase('guided');
    },
    [chosenKey, items, fireCompleted, testMode.mock, testMode.forceOnboarding]
  );

  // Initial load: test mode + status, then route.
  useEffect(() => {
    const init = async () => {
      const mode = await getOnboardingTestMode().catch(() => ({
        mock: false,
        forceOnboarding: false,
      }));
      setTestMode(mode);
      const status = await fetchStatus();
      if (!status) {
        setPhase('pick'); // show the error banner with Retry
        return;
      }
      if (!agentSetupStartedFired) {
        agentSetupStartedFired = true;
        void trackEvent('setup_started', { entry_path: 'agent_led', entry_step: null });
      }

      // Fast path: a fully set-up machine goes straight to celebration, same
      // as the classic wizard — except under force-onboarding, where showing
      // the pick phase is the whole point of launching with the env var.
      const readyPair = getReadyAgentPairs(status.items)[0];
      if (
        !mode.forceOnboarding &&
        readyPair &&
        getMissingRequiredItems(status.items).length === 0
      ) {
        const agentId = agentIdForBinary(readyPair.binaryId);
        await setDefaultAgentId(agentId);
        initDefaultAgent(agentId);
        setChosenKey(readyPair.binaryId as AgentCardKey);
        fireCompleted([agentId], 'agent_led_fast_path');
        setPhase('complete');
        return;
      }
      setActiveScreen('Onboarding - Agent Pick');
      setPhase('pick');
    };
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live verification while the agent works: poll real checks (or mock state
  // in demo mode) so the checklist ticks green as the agent installs things.
  // Hosting isn't part of "complete", but its checklist row still needs to
  // tick — keep polling until the Vercel pair settles too (found in VM
  // testing: polling stopped at required-complete and the Vercel row froze
  // gray while the agent was still installing it).
  const vercelRowSettled =
    hostChoice !== 'vercel' ||
    (items.find((i) => i.id === 'vercel')?.status === 'ready' &&
      items.find((i) => i.id === 'vercel_auth')?.status === 'ready');
  usePolling(fetchStatus, {
    intervalMs: 3000,
    enabled:
      phase === 'guided' &&
      !(isAgentLedSetupComplete(items, chosenBinaryId ?? null) && vercelRowSettled),
    name: 'agentOnboardingStatus',
  });

  const handleCardSelect = useCallback(
    (key: AgentCardKey) => {
      void trackEvent('agent_card_selected', {
        key,
        already_ready:
          key !== 'other' &&
          items.find((i) => i.id === key)?.status === 'ready' &&
          items.find((i) => i.id === `${key}_auth`)?.status === 'ready',
      });
      if (key === 'other') {
        void proceedWithOther();
        return;
      }
      const pairReady =
        items.find((i) => i.id === key)?.status === 'ready' &&
        items.find((i) => i.id === `${key}_auth`)?.status === 'ready';
      if (pairReady) {
        void proceedWithAgent(key);
      } else {
        setDetailAgent(key);
      }
    },
    [items, proceedWithAgent, proceedWithOther]
  );

  // Detail view: the moment the chosen pair turns fully ready (install +
  // sign-in verified), advance automatically — the user already committed by
  // clicking the card. Guarded to fire once.
  const advancedFromDetailRef = useRef(false);
  useEffect(() => {
    if (!detailAgent || phase !== 'pick') {
      advancedFromDetailRef.current = false;
      return;
    }
    const pairReady =
      items.find((i) => i.id === detailAgent)?.status === 'ready' &&
      items.find((i) => i.id === `${detailAgent}_auth`)?.status === 'ready';
    const busy = actions.activeItemId !== null || actions.terminalConfig !== null;
    if (pairReady && !busy && !advancedFromDetailRef.current) {
      advancedFromDetailRef.current = true;
      void proceedWithAgent(detailAgent);
    }
  }, [detailAgent, phase, items, actions.activeItemId, actions.terminalConfig, proceedWithAgent]);

  const handleVerified = useCallback(() => {
    fireCompleted(chosenBinaryId ? [agentIdForBinary(chosenBinaryId)] : ['other'], 'agent_led');
    setPhase('complete');
  }, [chosenBinaryId, fireCompleted]);

  if (phase === 'loading') {
    return (
      <div className="onboarding-screen onboarding-loading">
        <Spinner size="lg" style={{ color: 'var(--text-muted)' }} />
        <p>Checking setup status...</p>
      </div>
    );
  }

  if (phase === 'complete') {
    const hostingConnected =
      items.find((i) => i.id === 'vercel')?.status === 'ready' &&
      items.find((i) => i.id === 'vercel_auth')?.status === 'ready';
    return <CelebrationScreen onContinue={onComplete} hostingConnected={hostingConnected} />;
  }

  const chosenAgentDisplayName = chosenBinaryId
    ? getAgentById(agentIdForBinary(chosenBinaryId)).displayName
    : 'Your agent';

  return (
    <div className="onboarding-screen">
      <div
        className={`onboarding-content agent-onboarding-content ${phase === 'guided' ? 'agent-guided-content' : ''}`}
      >
        <div className="onboarding-header">
          <img src="/ship_studio_full.png" alt="Ship Studio" className="onboarding-logo" />
          {phase === 'pick' && !detailAgent && (
            <>
              <h1>First, pick your AI agent</h1>
              <p className="onboarding-reassurance">
                To start building, your computer needs a few tools — Git, GitHub, and Node.js. The
                best way to install them is with an AI agent: it does the work and explains each
                step. Which one would you like to use?
              </p>
            </>
          )}
          {phase === 'hosting' && (
            <>
              <h1>Where should your sites go live?</h1>
              <p className="onboarding-reassurance">
                Pick a hosting provider — new projects will publish there by default, and your agent
                will set it up for you. Not sure? Skip it and decide later.
              </p>
            </>
          )}
        </div>

        {error && (
          <div className="onboarding-error">
            <p>{error}</p>
            <Button variant="secondary" onClick={() => void fetchStatus()}>
              Retry
            </Button>
          </div>
        )}

        {phase === 'pick' && !detailAgent && (
          <AgentPickGrid
            items={items}
            onSelect={handleCardSelect}
            disabled={actions.activeItemId !== null || actions.terminalConfig !== null}
          />
        )}

        {phase === 'pick' && detailAgent && detailAgent !== 'other' && (
          <AgentSetupDetail
            binaryId={detailAgent}
            displayName={getAgentById(agentIdForBinary(detailAgent)).displayName}
            icon={DETAIL_ICONS[detailAgent]}
            items={items}
            onItemAction={(id) => void actions.handleItemAction(id)}
            activeItemId={actions.activeItemId}
            terminalActive={actions.terminalConfig !== null}
            onBack={() => setDetailAgent(null)}
          />
        )}

        {phase === 'hosting' && (
          <HostingPickGrid
            items={items}
            onSelect={(host) => void handleHostDecision(host)}
            onSkip={() => void handleHostDecision(null)}
          />
        )}

        {phase === 'guided' && chosenKey && (
          <GuidedSetupPhase
            agentBinaryId={chosenBinaryId}
            agentDisplayName={chosenAgentDisplayName}
            items={items}
            hostChoice={hostChoice}
            demoMode={testMode.mock}
            onVerified={handleVerified}
          />
        )}

        {/* Terminal modal for Phase 0 install/connect commands (same chrome
            as the classic wizard — shared CSS classes from setup.css). */}
        {actions.terminalConfig && (
          <div className="onboarding-terminal-overlay">
            <div className="onboarding-terminal-modal">
              <div className="onboarding-terminal-header">
                <span className="onboarding-terminal-title">
                  {SETUP_FRIENDLY_NAMES[actions.terminalConfig.itemId] ||
                    actions.terminalConfig.itemId}
                </span>
                <Button variant="ghost" size="compact" onClick={actions.handleTerminalCancel}>
                  {actions.terminalExitCode ? 'Close' : 'Cancel'}
                </Button>
              </div>
              <OnboardingTerminal
                command={actions.terminalConfig.command}
                args={actions.terminalConfig.args}
                onExit={(exitCode, outputTail) =>
                  void actions.handleTerminalExit(exitCode, outputTail)
                }
              />
              <div className="onboarding-terminal-hint">
                <strong>If you're asked for a password</strong>, type it and press Enter. It stays
                hidden as you type — no dots or characters appear — but it is being entered.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
