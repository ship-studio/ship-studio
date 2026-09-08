/**
 * Chooses between the three onboarding experiences.
 *
 * - `flow` — conversational: one question at a time, with a built-in agent
 *   doing the installs between questions. Newest, and only usable where an
 *   install-agent driver exists (see {@link defaultMode}).
 * - `agent` — today's agent-led flow: pick and sign into an agent, then hand
 *   that agent a setup prompt. Fully wired and unchanged.
 * - `classic` — the deterministic 4-step wizard. The support escape hatch when
 *   anything agent-shaped goes sideways.
 *
 * None of the three is deleted or degraded by the presence of the others, and
 * the corner button cycles through all of them, so a state that only
 * reproduces in one is always one click away. The choice persists in
 * localStorage so a restart lands the user back where they were.
 *
 * **To return to today's behaviour entirely, set {@link FLOW_ENABLED} to
 * false.** That is the whole revert: `flow` stops being a default and stops
 * appearing in the cycle, and every user lands on agent-led exactly as before.
 */

import { useCallback, useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { OnboardingScreen } from './OnboardingScreen';
import { AgentOnboardingScreen } from './agent-led/AgentOnboardingScreen';
import { FlowOnboarding } from './flow/FlowOnboarding';
import { scriptedDriver } from '../../lib/installAgent';
import { getOnboardingTestMode, OnboardingTestMode } from '../../lib/agentOnboarding';
import { trackEvent } from '../../lib/analytics';
import { logger } from '../../lib/logger';

export type OnboardingMode = 'flow' | 'agent' | 'classic';

const MODE_STORAGE_KEY = 'shipstudio.onboardingMode';

/**
 * Master switch for the conversational flow. Flip to `false` to put every user
 * back on today's onboarding without touching anything else — the flow's
 * components stay compiled and reachable by an explicit stored preference, but
 * nothing routes to it by default and the cycle skips it.
 */
const FLOW_ENABLED = true;

/**
 * The user's remembered choice, or null to let the default rule decide.
 *
 * Null rather than a constant fallback because the default now depends on
 * something we can only learn asynchronously — whether an install-agent driver
 * exists on this launch. See {@link defaultMode}.
 */
function readStoredMode(): OnboardingMode | null {
  try {
    const stored = localStorage.getItem(MODE_STORAGE_KEY);
    if (stored === 'classic' || stored === 'agent' || stored === 'flow') return stored;
    return null;
  } catch {
    return null;
  }
}

/**
 * Which experience a first-time user gets.
 *
 * The conversational flow needs an install-agent driver to do any real work,
 * and today the only driver is the scripted one that runs under
 * `SHIPSTUDIO_FORCE_SETUP`. On a real machine we therefore stay on agent-led:
 * a prettier flow that silently installs nothing would be a worse product than
 * the plainer one that works. This condition is the whole gate — when a real
 * driver lands, delete the `mock` check, not the flow.
 *
 * Agent-led is the default on every platform. Windows briefly defaulted to the
 * classic wizard while agent-led was runtime-untested there; with the Windows
 * terminal-spawn fix (#218) landed and the winget/PowerShell paths in place,
 * both platforms start agent-led. "Try classic onboarding" stays pinned as the
 * always-available escape hatch.
 */
function defaultMode(testMode: OnboardingTestMode | null): OnboardingMode {
  return FLOW_ENABLED && testMode?.mock ? 'flow' : 'agent';
}

/** Modes the corner button cycles through, in order. */
function modeCycle(testMode: OnboardingTestMode | null): OnboardingMode[] {
  const flowUsable = FLOW_ENABLED && testMode?.mock;
  return flowUsable ? ['flow', 'agent', 'classic'] : ['agent', 'classic'];
}

const MODE_TOGGLE_LABELS: Record<OnboardingMode, string> = {
  flow: 'Try guided setup',
  agent: 'Try agent-led setup',
  classic: 'Try classic onboarding',
};

interface OnboardingRouterProps {
  /** Called when setup is complete and the user continues. */
  onComplete: () => void;
}

export function OnboardingRouter({ onComplete }: OnboardingRouterProps) {
  const [storedMode, setStoredMode] = useState<OnboardingMode | null>(readStoredMode);
  const [testMode, setTestMode] = useState<OnboardingTestMode | null>(null);

  useEffect(() => {
    void getOnboardingTestMode()
      .then(setTestMode)
      .catch((err) => {
        // Not knowing the test mode just means the real-machine default.
        logger.warn('Onboarding router: test mode check failed', { error: String(err) });
        setTestMode({ mock: false, forceOnboarding: false });
      });
  }, []);

  const mode = storedMode ?? defaultMode(testMode);
  // The button always advertises where it goes, so the cycle is discoverable
  // rather than something you have to click twice to understand.
  const cycle = modeCycle(testMode);
  const nextMode = cycle[(cycle.indexOf(mode) + 1) % cycle.length] ?? 'classic';

  const handleDrag = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, select, [role="button"]')) return;
    e.preventDefault();
    void getCurrentWindow().startDragging();
  }, []);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, select, [role="button"]')) return;
    const win = getCurrentWindow();
    void win.isMaximized().then((maximized) => {
      void (maximized ? win.unmaximize() : win.maximize());
    });
  }, []);

  const switchMode = useCallback((next: OnboardingMode) => {
    try {
      localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch (err) {
      logger.warn('Failed to persist onboarding mode', { error: String(err) });
    }
    void trackEvent('onboarding_mode_switched', { to: next });
    setStoredMode(next);
  }, []);

  return (
    <div className="onboarding-router">
      <div
        className="onboarding-drag-region"
        onMouseDown={handleDrag}
        onDoubleClick={handleDoubleClick}
      />
      {mode === 'flow' && (
        <FlowOnboarding key="flow" driver={scriptedDriver} onComplete={onComplete} />
      )}
      {mode === 'agent' && <AgentOnboardingScreen key="agent" onComplete={onComplete} />}
      {mode === 'classic' && <OnboardingScreen key="classic" onComplete={onComplete} />}
      <button type="button" className="onboarding-mode-toggle" onClick={() => switchMode(nextMode)}>
        {MODE_TOGGLE_LABELS[nextMode]}
      </button>
    </div>
  );
}
