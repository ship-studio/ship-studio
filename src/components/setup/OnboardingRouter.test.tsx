/**
 * Tests for the onboarding mode router: agent-led is the default, the classic
 * escape hatch is pinned in view at all times, and the choice persists across
 * restarts via localStorage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OnboardingRouter } from './OnboardingRouter';

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

describe('OnboardingRouter', () => {
  beforeEach(() => {
    localStorage.clear();
    isWindowsMock.mockReturnValue(false);
  });

  it('defaults to the agent-led experience', () => {
    render(<OnboardingRouter onComplete={vi.fn()} />);
    expect(screen.getByTestId('agent-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('classic-screen')).not.toBeInTheDocument();
  });

  it('defaults Windows to the agent-led experience too', () => {
    isWindowsMock.mockReturnValue(true);
    render(<OnboardingRouter onComplete={vi.fn()} />);
    expect(screen.getByTestId('agent-screen')).toBeInTheDocument();
    // The classic escape hatch stays pinned in view.
    expect(screen.getByRole('button', { name: 'Try classic onboarding' })).toBeInTheDocument();
  });

  it('a stored classic choice on Windows overrides the agent default', () => {
    isWindowsMock.mockReturnValue(true);
    localStorage.setItem('shipstudio.onboardingMode', 'classic');
    render(<OnboardingRouter onComplete={vi.fn()} />);
    expect(screen.getByTestId('classic-screen')).toBeInTheDocument();
  });

  it('always shows the classic escape hatch in agent mode', () => {
    render(<OnboardingRouter onComplete={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Try classic onboarding' })).toBeInTheDocument();
  });

  it('switches to classic and persists the choice', () => {
    render(<OnboardingRouter onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try classic onboarding' }));
    expect(screen.getByTestId('classic-screen')).toBeInTheDocument();
    expect(localStorage.getItem('shipstudio.onboardingMode')).toBe('classic');
  });

  it('restores a persisted classic choice on mount and can switch back', () => {
    localStorage.setItem('shipstudio.onboardingMode', 'classic');
    render(<OnboardingRouter onComplete={vi.fn()} />);
    expect(screen.getByTestId('classic-screen')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try agent-led setup' }));
    expect(screen.getByTestId('agent-screen')).toBeInTheDocument();
    expect(localStorage.getItem('shipstudio.onboardingMode')).toBe('agent');
  });

  it('treats unknown stored values as the agent default', () => {
    localStorage.setItem('shipstudio.onboardingMode', 'garbage');
    render(<OnboardingRouter onComplete={vi.fn()} />);
    expect(screen.getByTestId('agent-screen')).toBeInTheDocument();
  });
});
