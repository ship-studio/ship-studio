/**
 * Chooses between the two onboarding experiences.
 *
 * Agent-led is the default; the classic step-by-step wizard stays one click
 * away at all times via the pinned corner button — the support escape hatch
 * when an agent-led session goes sideways ("Try classic onboarding"). The
 * choice persists in localStorage so a restart lands the user back in the
 * mode that was working for them.
 */

import { useCallback, useState } from 'react';
import { OnboardingScreen } from './OnboardingScreen';
import { AgentOnboardingScreen } from './agent-led/AgentOnboardingScreen';
import { trackEvent } from '../../lib/analytics';
import { logger } from '../../lib/logger';
import { isWindows } from '../../lib/setup';

export type OnboardingMode = 'agent' | 'classic';

const MODE_STORAGE_KEY = 'shipstudio.onboardingMode';

function readStoredMode(): OnboardingMode {
  // Windows defaults to the classic wizard until the agent-led flow gets a
  // real Windows pass — a broken first run is the one place the "classic is
  // one click away" fallback isn't enough, because a brand-new user doesn't
  // know it's the fix. "Try agent-guided setup" stays available as an opt-in.
  const fallback: OnboardingMode = isWindows() ? 'classic' : 'agent';
  try {
    const stored = localStorage.getItem(MODE_STORAGE_KEY);
    if (stored === 'classic' || stored === 'agent') return stored;
    return fallback;
  } catch {
    return fallback;
  }
}

interface OnboardingRouterProps {
  /** Called when setup is complete and the user continues. */
  onComplete: () => void;
}

export function OnboardingRouter({ onComplete }: OnboardingRouterProps) {
  const [mode, setMode] = useState<OnboardingMode>(readStoredMode);

  const switchMode = useCallback((next: OnboardingMode) => {
    try {
      localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch (err) {
      logger.warn('Failed to persist onboarding mode', { error: String(err) });
    }
    void trackEvent('onboarding_mode_switched', { to: next });
    setMode(next);
  }, []);

  return (
    <div className="onboarding-router">
      {mode === 'agent' ? (
        <AgentOnboardingScreen key="agent" onComplete={onComplete} />
      ) : (
        <OnboardingScreen key="classic" onComplete={onComplete} />
      )}
      <button
        type="button"
        className="onboarding-mode-toggle"
        onClick={() => switchMode(mode === 'agent' ? 'classic' : 'agent')}
      >
        {mode === 'agent' ? 'Try classic onboarding' : 'Try agent-guided setup'}
      </button>
    </div>
  );
}
