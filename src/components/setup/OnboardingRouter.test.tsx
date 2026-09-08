/**
 * Tests for the onboarding mode router: agent-led is the default, the classic
 * escape hatch is pinned in view at all times, and the choice persists across
 * restarts via localStorage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { OnboardingRouter } from './OnboardingRouter';
import { getOnboardingTestMode } from '../../lib/agentOnboarding';

vi.mock('./OnboardingScreen', () => ({
  OnboardingScreen: () => <div data-testid="classic-screen" />,
}));
vi.mock('./agent-led/AgentOnboardingScreen', () => ({
  AgentOnboardingScreen: () => <div data-testid="agent-screen" />,
}));
vi.mock('../../lib/analytics', () => ({
  trackEvent: vi.fn(() => Promise.resolve()),
  trackPageview: vi.fn(),
}));

// `vi.hoisted` because the mock factory is hoisted above this file's `const`
// declarations, and the router's import chain now reaches lib/setup during
// module evaluation — which is early enough to touch the ref before a plain
// `const` has initialised it.
const { isWindowsMock } = vi.hoisted(() => ({ isWindowsMock: vi.fn(() => false) }));
vi.mock('../../lib/setup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/setup')>()),
  isWindows: () => isWindowsMock(),
}));

// The router asks the backend whether this launch is in mock mode, to decide
// whether the conversational flow can do any real work. Default: it can't, so
// these tests describe the real-machine routing.
vi.mock('../../lib/agentOnboarding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agentOnboarding')>()),
  getOnboardingTestMode: vi.fn(() => Promise.resolve({ mock: false, forceOnboarding: false })),
}));
vi.mock('./flow/FlowOnboarding', () => ({
  FlowOnboarding: () => <div data-testid="flow-screen" />,
}));

/**
 * Render and let the router's mount-time `getOnboardingTestMode` resolve.
 *
 * The router asks the backend whether this launch can run the conversational
 * flow, so every mount has one pending promise. Flushing it here keeps the
 * assertions describing settled UI rather than the frame before it.
 */
async function renderRouter() {
  const result = render(<OnboardingRouter onComplete={vi.fn()} />);
  await act(async () => {});
  return result;
}

describe('OnboardingRouter', () => {
  beforeEach(() => {
    localStorage.clear();
    isWindowsMock.mockReturnValue(false);
  });

  it('defaults to the agent-led experience', async () => {
    await renderRouter();
    expect(screen.getByTestId('agent-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('classic-screen')).not.toBeInTheDocument();
  });

  it('defaults Windows to the agent-led experience too', async () => {
    isWindowsMock.mockReturnValue(true);
    await renderRouter();
    expect(screen.getByTestId('agent-screen')).toBeInTheDocument();
    // The classic escape hatch stays pinned in view.
    expect(screen.getByRole('button', { name: 'Try classic onboarding' })).toBeInTheDocument();
  });

  it('a stored classic choice on Windows overrides the agent default', async () => {
    isWindowsMock.mockReturnValue(true);
    localStorage.setItem('shipstudio.onboardingMode', 'classic');
    await renderRouter();
    expect(screen.getByTestId('classic-screen')).toBeInTheDocument();
  });

  it('always shows the classic escape hatch in agent mode', async () => {
    await renderRouter();
    expect(screen.getByRole('button', { name: 'Try classic onboarding' })).toBeInTheDocument();
  });

  it('switches to classic and persists the choice', async () => {
    await renderRouter();
    fireEvent.click(screen.getByRole('button', { name: 'Try classic onboarding' }));
    expect(screen.getByTestId('classic-screen')).toBeInTheDocument();
    expect(localStorage.getItem('shipstudio.onboardingMode')).toBe('classic');
  });

  it('restores a persisted classic choice on mount and can switch back', async () => {
    localStorage.setItem('shipstudio.onboardingMode', 'classic');
    await renderRouter();
    expect(screen.getByTestId('classic-screen')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try agent-led setup' }));
    expect(screen.getByTestId('agent-screen')).toBeInTheDocument();
    expect(localStorage.getItem('shipstudio.onboardingMode')).toBe('agent');
  });

  it('treats unknown stored values as the agent default', async () => {
    localStorage.setItem('shipstudio.onboardingMode', 'garbage');
    await renderRouter();
    expect(screen.getByTestId('agent-screen')).toBeInTheDocument();
  });

  describe('the conversational flow', () => {
    it('is not the default on a real machine, where no driver can install anything', async () => {
      await renderRouter();
      expect(screen.queryByTestId('flow-screen')).not.toBeInTheDocument();
      expect(screen.getByTestId('agent-screen')).toBeInTheDocument();
    });

    it('is the default where a driver exists', async () => {
      vi.mocked(getOnboardingTestMode).mockResolvedValueOnce({
        mock: true,
        forceOnboarding: false,
      });
      await renderRouter();
      expect(screen.getByTestId('flow-screen')).toBeInTheDocument();
    });

    it('cycles flow → agent-led → classic, so every experience stays reachable', async () => {
      vi.mocked(getOnboardingTestMode).mockResolvedValueOnce({
        mock: true,
        forceOnboarding: false,
      });
      await renderRouter();

      fireEvent.click(screen.getByRole('button', { name: 'Try agent-led setup' }));
      expect(screen.getByTestId('agent-screen')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Try classic onboarding' }));
      expect(screen.getByTestId('classic-screen')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Try guided setup' }));
      expect(screen.getByTestId('flow-screen')).toBeInTheDocument();
    });

    it('is skipped by the cycle when no driver exists', async () => {
      await renderRouter();
      fireEvent.click(screen.getByRole('button', { name: 'Try classic onboarding' }));
      expect(screen.getByTestId('classic-screen')).toBeInTheDocument();

      // Back to agent-led, never to a flow that could not install anything.
      fireEvent.click(screen.getByRole('button', { name: 'Try agent-led setup' }));
      expect(screen.getByTestId('agent-screen')).toBeInTheDocument();
    });
  });
});
