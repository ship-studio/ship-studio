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
import { getCurrentWindow } from '@tauri-apps/api/window';
import { OnboardingScreen } from './OnboardingScreen';
import { AgentOnboardingScreen } from './agent-led/AgentOnboardingScreen';
import { trackEvent } from '../../lib/analytics';
import { logger } from '../../lib/logger';

export type OnboardingMode = 'agent' | 'classic';

const MODE_STORAGE_KEY = 'shipstudio.onboardingMode';

function readStoredMode(): OnboardingMode {
  // Agent-led is the default on every platform. Windows briefly defaulted to
  // the classic wizard while the agent-led flow was runtime-untested there;
  // with the Windows terminal-spawn fix (#218) landed and the flow's winget/
  // PowerShell paths in place, both platforms start agent-led. "Try classic
  // onboarding" stays pinned as the always-available escape hatch.
  const fallback: OnboardingMode = 'agent';
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
    setMode(next);
  }, []);

  return (
    <div className="onboarding-router">
      <div
        className="onboarding-drag-region"
        onMouseDown={handleDrag}
        onDoubleClick={handleDoubleClick}
      />
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
