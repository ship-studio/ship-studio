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

const isWindowsMock = vi.fn(() => false);
vi.mock('../../lib/setup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/setup')>()),
  isWindows: () => isWindowsMock(),
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

  it('defaults Windows to the classic wizard (agent-led stays opt-in)', () => {
    isWindowsMock.mockReturnValue(true);
    render(<OnboardingRouter onComplete={vi.fn()} />);
    expect(screen.getByTestId('classic-screen')).toBeInTheDocument();
    // The opt-in toggle into agent-led is still pinned in view.
    expect(screen.getByRole('button', { name: 'Try agent-guided setup' })).toBeInTheDocument();
  });

  it('a stored agent choice on Windows overrides the classic default', () => {
    isWindowsMock.mockReturnValue(true);
    localStorage.setItem('shipstudio.onboardingMode', 'agent');
    render(<OnboardingRouter onComplete={vi.fn()} />);
    expect(screen.getByTestId('agent-screen')).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('button', { name: 'Try agent-guided setup' }));
    expect(screen.getByTestId('agent-screen')).toBeInTheDocument();
    expect(localStorage.getItem('shipstudio.onboardingMode')).toBe('agent');
  });

  it('treats unknown stored values as the agent default', () => {
    localStorage.setItem('shipstudio.onboardingMode', 'garbage');
    render(<OnboardingRouter onComplete={vi.fn()} />);
    expect(screen.getByTestId('agent-screen')).toBeInTheDocument();
  });
});
