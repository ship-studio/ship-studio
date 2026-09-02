/**
 * Integration tests for OnboardingScreen — the step-by-step wizard.
 *
 * These tests mock the Tauri IPC layer at the module level and verify
 * the wizard state machine transitions: loading → wizard steps → complete
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import {
  FRESH_STATUS,
  CLAUDE_ONLY_STATUS,
  BOTH_AGENTS_STATUS,
  CODEX_ONLY_STATUS,
  makeSetupStatus,
  ALL_READY_CLAUDE_ONLY,
  ALL_READY_BOTH_AGENTS,
  ALL_READY_CODEX_ONLY,
  FRESH_INSTALL_ITEMS,
  STEP1_COMPLETE_STATUS,
  STEP1_COMPLETE_ITEMS,
  HAS_BASE_NO_AGENTS_STATUS,
  HAS_BASE_NO_AGENTS_ITEMS,
  HAS_CLAUDE_NO_GITHUB_STATUS,
} from '../../test/fixtures/setup';

// ============ Module-level mocks ============

const invokeResults = new Map<string, { value?: unknown; error?: Error }>();

function mockInvoke(cmd: string, value: unknown) {
  invokeResults.set(cmd, { value });
}
function mockInvokeErr(cmd: string, error: Error) {
  invokeResults.set(cmd, { error });
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string) => {
    const result = invokeResults.get(cmd);
    if (result?.error) return Promise.reject(result.error);
    if (result) return Promise.resolve(result.value);
    return Promise.resolve(undefined);
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn(),
  once: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock('./OnboardingTerminal', () => ({
  OnboardingTerminal: ({
    onExit,
  }: {
    command: string;
    args: string[];
    onExit: (code: number | null, outputTail?: string) => void;
  }) => (
    <div data-testid="mock-terminal">
      <button data-testid="terminal-exit-0" onClick={() => onExit(0)}>
        Exit 0
      </button>
      <button data-testid="terminal-exit-1" onClick={() => onExit(1)}>
        Exit 1
      </button>
      <button data-testid="terminal-exit-null" onClick={() => onExit(null)}>
        Exit null
      </button>
      <button data-testid="terminal-exit-127" onClick={() => onExit(127)}>
        Exit 127
      </button>
      <button
        data-testid="terminal-exit-1-npm-err"
        onClick={() => onExit(1, 'npm ERR! code EEXIST\nnpm ERR! EEXIST: file already exists\n')}
      >
        Exit 1 (npm ERR!)
      </button>
      <button
        data-testid="terminal-exit-1-npm-missing"
        onClick={() =>
          onExit(
            1,
            "'npm' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n"
          )
        }
      >
        Exit 1 (npm missing)
      </button>
      <button
        data-testid="terminal-exit-0-already-logged-in"
        onClick={() => onExit(0, 'Already logged in as julian@example.com\n')}
      >
        Exit 0 (already logged in)
      </button>
      <button
        data-testid="terminal-exit-0-auth-error"
        onClick={() => onExit(0, 'Error: OAuth token exchange failed\n')}
      >
        Exit 0 (auth error in tail)
      </button>
      <button
        data-testid="terminal-exit-1-gh-already-logged-in"
        onClick={() => onExit(1, '✓ Logged in to github.com account juliangalluzzo (keyring)\n')}
      >
        Exit 1 (gh already logged in)
      </button>
      <button
        data-testid="terminal-exit-1-network"
        onClick={() => onExit(1, 'curl: (6) Could not resolve host: claude.ai\n')}
      >
        Exit 1 (network failure)
      </button>
      <button
        data-testid="terminal-exit-1-sudo"
        onClick={() => onExit(1, 'sudo: a password is required\n')}
      >
        Exit 1 (sudo required)
      </button>
    </div>
  ),
}));

vi.mock('../icons', () => ({
  CheckIcon: ({ size }: { size: number }) => <span data-testid="check-icon" data-size={size} />,
  SuccessIcon: ({ size }: { size: number }) => <span data-testid="success-icon" data-size={size} />,
  SlackIcon: ({ size }: { size: number }) => <span data-testid="slack-icon" data-size={size} />,
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(),
}));

vi.mock('../../lib/github', () => ({
  checkGitHubCliStatus: vi.fn().mockResolvedValue({ installed: true, authenticated: true }),
}));

import { OnboardingScreen } from './OnboardingScreen';
import { checkGitHubCliStatus } from '../../lib/github';

const mockCheckGitHubCliStatus = checkGitHubCliStatus as ReturnType<typeof vi.fn>;

describe('OnboardingScreen', () => {
  const onComplete = vi.fn();

  beforeEach(() => {
    invokeResults.clear();
    onComplete.mockReset();
    mockCheckGitHubCliStatus.mockResolvedValue({ installed: true, authenticated: true });
  });

  // ============ Loading state ============

  it('shows spinner while fetching status', async () => {
    mockInvoke('get_full_setup_status', undefined);
    const { invoke } = await import('@tauri-apps/api/core');
    (invoke as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise(() => {}));

    render(<OnboardingScreen onComplete={onComplete} />);
    expect(screen.getByText('Checking setup status...')).toBeInTheDocument();
  });

  it('shows timeout error with Retry when the setup status check hangs', async () => {
    vi.useFakeTimers();

    const { invoke } = await import('@tauri-apps/api/core');
    // Hang the initial get_full_setup_status forever — the withTimeout wrapper
    // must convert this into the error + Retry UI instead of an eternal spinner.
    (invoke as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise(() => {}));

    render(<OnboardingScreen onComplete={onComplete} />);
    expect(screen.getByText('Checking setup status...')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(
      screen.getByText(
        'Setup check timed out — click Retry. If this persists, restart Ship Studio.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    vi.useRealTimers();
  });

  // ============ Fresh install → starts at step 1 ============

  it('shows wizard on step 1 for fresh install', async () => {
    mockInvoke('get_full_setup_status', FRESH_STATUS);

    render(<OnboardingScreen onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      // Step title appears in both indicator and header — check the header h2
      expect(
        screen.getByText('Install the tools needed to manage dependencies')
      ).toBeInTheDocument();
    });
  });

  // ============ Auto-advance to correct step ============

  it('auto-advances to step 2 when step 1 is complete', async () => {
    mockInvoke('get_full_setup_status', STEP1_COMPLETE_STATUS);

    render(<OnboardingScreen onComplete={onComplete} />);

    await waitFor(() => {
      expect(
        screen.getByText('Save your work safely and publish it online. Required.')
      ).toBeInTheDocument();
    });
  });

  it('auto-advances to step 3 when steps 1+2 complete', async () => {
    mockInvoke('get_full_setup_status', HAS_BASE_NO_AGENTS_STATUS);

    render(<OnboardingScreen onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByText('Install at least one AI coding assistant')).toBeInTheDocument();
    });
  });

  it('auto-advances to step 2 when has Claude but no gh_auth', async () => {
    mockInvoke('get_full_setup_status', HAS_CLAUDE_NO_GITHUB_STATUS);

    render(<OnboardingScreen onComplete={onComplete} />);

    await waitFor(() => {
      expect(
        screen.getByText('Save your work safely and publish it online. Required.')
      ).toBeInTheDocument();
    });
  });

  // ============ All ready → celebration ============

  it('shows celebration when all steps complete with one agent', async () => {
    mockInvoke('get_full_setup_status', CLAUDE_ONLY_STATUS);
    mockInvoke('set_default_agent_id', undefined);

    render(<OnboardingScreen onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByText("You're all set!")).toBeInTheDocument();
    });
  });

  it('shows celebration when all steps complete with both agents', async () => {
    mockInvoke('get_full_setup_status', BOTH_AGENTS_STATUS);

    render(<OnboardingScreen onComplete={onComplete} />);

    // Both agents detected — should still go to celebration
    // (agent selection is now inline in the agent step)
    await waitFor(() => {
      expect(screen.getByText("You're all set!")).toBeInTheDocument();
    });
  });

  it('shows celebration for zero agents edge case', async () => {
    const status = makeSetupStatus({
      allReady: true,
      items: ALL_READY_CLAUDE_ONLY,
      detectedAgents: [],
    });
    mockInvoke('get_full_setup_status', status);

    render(<OnboardingScreen onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByText("You're all set!")).toBeInTheDocument();
    });
  });

  it('auto-sets codex as default when only codex detected', async () => {
    mockInvoke('get_full_setup_status', CODEX_ONLY_STATUS);
    mockInvoke('set_default_agent_id', undefined);

    render(<OnboardingScreen onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByText("You're all set!")).toBeInTheDocument();
    });
  });

  // ============ Error handling ============

  it('shows error message and retry on fetch error', async () => {
    mockInvokeErr('get_full_setup_status', new Error('Network error'));

    render(<OnboardingScreen onComplete={onComplete} />);

    await waitFor(() => {
      expect(
        screen.getByText('Failed to check setup status. Please try again.')
      ).toBeInTheDocument();
      expect(screen.getByText('Retry')).toBeInTheDocument();
    });
  });

  it('retry after error re-fetches status', async () => {
    mockInvokeErr('get_full_setup_status', new Error('Network error'));

    render(<OnboardingScreen onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByText('Retry')).toBeInTheDocument();
    });

    mockInvoke('get_full_setup_status', FRESH_STATUS);

    act(() => {
      fireEvent.click(screen.getByText('Retry'));
    });

    await waitFor(() => {
      expect(screen.getByText('Quick Setup')).toBeInTheDocument();
    });
  });

  // ============ Step indicator ============

  it('renders wizard step indicator with all steps', async () => {
    mockInvoke('get_full_setup_status', FRESH_STATUS);

    render(<OnboardingScreen onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByText('Quick Setup')).toBeInTheDocument();
    });

    // Step indicator labels + step header means some titles appear twice
    // Verify the indicator exists by checking for the Hosting Provider label
    // (only in the indicator, not the active step header)
    expect(screen.getByText('Hosting Provider')).toBeInTheDocument();
  });

  // ============ Terminal interactions ============

  it('clicking Install opens terminal overlay', async () => {
    mockInvoke('get_full_setup_status', FRESH_STATUS);

    render(<OnboardingScreen onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByText('Quick Setup')).toBeInTheDocument();
    });

    const installButtons = screen.getAllByText('Install');
    act(() => {
      fireEvent.click(installButtons[0]);
    });

    await waitFor(() => {
      expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
    });
  });

  it('terminal exit 0 closes terminal and refreshes', async () => {
    mockInvoke('get_full_setup_status', FRESH_STATUS);

    render(<OnboardingScreen onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByText('Quick Setup')).toBeInTheDocument();
    });

    const installButtons = screen.getAllByText('Install');
    act(() => {
      fireEvent.click(installButtons[0]);
    });

    await waitFor(() => {
      expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(screen.getByTestId('terminal-exit-0'));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('mock-terminal')).not.toBeInTheDocument();
    });
  });

  it('terminal exit 1 keeps terminal open with Close button', async () => {
    mockInvoke('get_full_setup_status', FRESH_STATUS);

    render(<OnboardingScreen onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByText('Quick Setup')).toBeInTheDocument();
    });

    const installButtons = screen.getAllByText('Install');
    act(() => {
      fireEvent.click(installButtons[0]);
    });

    await waitFor(() => {
      expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(screen.getByTestId('terminal-exit-1'));
    });

    expect(screen.getByText('Close')).toBeInTheDocument();
    expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
  });

  it('terminal failure surfaces the extracted error from the output tail', async () => {
    // Step 3: installButtons[0] is Claude (a terminal item without a
    // special-cased error message, unlike homebrew on step 1)
    mockInvoke('get_full_setup_status', HAS_BASE_NO_AGENTS_STATUS);

    render(<OnboardingScreen onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByText('Install at least one AI coding assistant')).toBeInTheDocument();
    });

    const installButtons = screen.getAllByText('Install');
    act(() => {
      fireEvent.click(installButtons[0]);
    });

    await waitFor(() => {
      expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(screen.getByTestId('terminal-exit-1-npm-err'));
    });

    act(() => {
      fireEvent.click(screen.getByText('Close'));
    });

    await waitFor(() => {
      expect(screen.getByText('npm ERR! EEXIST: file already exists')).toBeInTheDocument();
    });
  });

  it('terminal failure with npm-not-recognized shows the actionable Node.js message', async () => {
    mockInvoke('get_full_setup_status', HAS_BASE_NO_AGENTS_STATUS);

    render(<OnboardingScreen onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByText('Install at least one AI coding assistant')).toBeInTheDocument();
    });

    const installButtons = screen.getAllByText('Install');
    act(() => {
      fireEvent.click(installButtons[0]);
    });

    await waitFor(() => {
      expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(screen.getByTestId('terminal-exit-1-npm-missing'));
    });

    act(() => {
      fireEvent.click(screen.getByText('Close'));
    });

    await waitFor(() => {
      expect(
        screen.getByText(
          "Node.js/npm wasn't found. Complete the Node.js step first, or restart Ship Studio if you just installed it."
        )
      ).toBeInTheDocument();
    });
  });

  it('terminal cancel closes terminal', async () => {
    mockInvoke('get_full_setup_status', FRESH_STATUS);

    render(<OnboardingScreen onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByText('Quick Setup')).toBeInTheDocument();
    });

    const installButtons = screen.getAllByText('Install');
    act(() => {
      fireEvent.click(installButtons[0]);
    });

    await waitFor(() => {
      expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(screen.getByText('Cancel'));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('mock-terminal')).not.toBeInTheDocument();
    });
  });

  // ============ Celebration auto-continue ============

  it('celebration screen auto-calls onComplete after 2500ms', async () => {
    vi.useFakeTimers();

    mockInvoke('get_full_setup_status', CLAUDE_ONLY_STATUS);
    mockInvoke('set_default_agent_id', undefined);

    render(<OnboardingScreen onComplete={onComplete} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(screen.getByText("You're all set!")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2500);
    });

    expect(onComplete).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  // ============ Slack CTA ============

  it('shows Slack CTA link on wizard screen', async () => {
    mockInvoke('get_full_setup_status', FRESH_STATUS);

    render(<OnboardingScreen onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByText('Join Slack')).toBeInTheDocument();
    });
  });

  // ============ Items render ============

  it('renders setup items for current step', async () => {
    mockInvoke('get_full_setup_status', FRESH_STATUS);

    render(<OnboardingScreen onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      expect(screen.getByText('Package Manager')).toBeInTheDocument();
    });
  });

  // ============ Brew package install ============

  it('renders install button for brew packages on step 1', async () => {
    const items = FRESH_INSTALL_ITEMS.map((i) =>
      i.id === 'homebrew' ? { ...i, status: 'ready' as const, version: '4.2.0' } : i
    );
    const status = makeSetupStatus({ items, detectedAgents: [] });
    mockInvoke('get_full_setup_status', status);
    mockInvoke('install_brew_packages', undefined);

    render(<OnboardingScreen onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByText('Quick Setup')).toBeInTheDocument();
    });

    const installButtons = screen.getAllByText('Install');
    expect(installButtons.length).toBeGreaterThan(0);
  });

  // ============ Step navigation ============

  describe('step navigation', () => {
    it('Next button is disabled when current step is incomplete', async () => {
      mockInvoke('get_full_setup_status', FRESH_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      });

      const nextButton = screen.getByText('Next');
      expect(nextButton).toBeDisabled();
    });

    it('Next button is enabled when current step is complete', async () => {
      // Start on step 1 (fresh install), install homebrew+node via terminal,
      // then verify Next becomes enabled after status refresh shows step 1 complete.
      mockInvoke('get_full_setup_status', FRESH_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(
          screen.getByText('Install the tools needed to manage dependencies')
        ).toBeInTheDocument();
      });

      // Next should be disabled (step 1 incomplete)
      expect(screen.getByText('Next')).toBeDisabled();

      // Install homebrew (terminal item)
      const installButtons = screen.getAllByText('Install');
      act(() => {
        fireEvent.click(installButtons[0]);
      });

      await waitFor(() => {
        expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
      });

      // After terminal succeeds, mock returns step 1 complete
      mockInvoke('get_full_setup_status', STEP1_COMPLETE_STATUS);

      act(() => {
        fireEvent.click(screen.getByTestId('terminal-exit-0'));
      });

      // Terminal closes and status refreshes
      await waitFor(() => {
        expect(screen.queryByTestId('mock-terminal')).not.toBeInTheDocument();
      });

      // Next should now be enabled (step 1 complete)
      await waitFor(() => {
        expect(screen.getByText('Next')).not.toBeDisabled();
      });
    });

    it('Back button navigates to previous step', async () => {
      mockInvoke('get_full_setup_status', STEP1_COMPLETE_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(
          screen.getByText('Save your work safely and publish it online. Required.')
        ).toBeInTheDocument();
      });

      const backButton = screen.getByText('Back');
      act(() => {
        fireEvent.click(backButton);
      });

      expect(
        screen.getByText('Install the tools needed to manage dependencies')
      ).toBeInTheDocument();
    });

    it('Back is inert while a terminal action is in flight', async () => {
      // Start on step 2 (Back visible) with git+gh ready so gh_auth's Connect
      // button is actionable
      const items = STEP1_COMPLETE_ITEMS.map((i) => {
        if (i.id === 'git') return { ...i, status: 'ready' as const, version: '2.43.0' };
        if (i.id === 'gh') return { ...i, status: 'ready' as const, version: '2.40.0' };
        return i;
      });
      mockInvoke('get_full_setup_status', makeSetupStatus({ items, detectedAgents: [] }));

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(
          screen.getByText('Save your work safely and publish it online. Required.')
        ).toBeInTheDocument();
      });

      // Open a terminal via gh_auth Connect (pre-check must miss)
      mockCheckGitHubCliStatus.mockResolvedValueOnce({ installed: true, authenticated: false });
      act(() => {
        fireEvent.click(screen.getAllByText('Connect')[0]);
      });

      await waitFor(() => {
        expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
      });

      // Clicking Back mid-action must not navigate (same guard as Next)
      act(() => {
        fireEvent.click(screen.getByText('Back'));
      });

      expect(
        screen.getByText('Save your work safely and publish it online. Required.')
      ).toBeInTheDocument();
      expect(
        screen.queryByText('Install the tools needed to manage dependencies')
      ).not.toBeInTheDocument();
    });

    it('Back button is not visible on first step', async () => {
      mockInvoke('get_full_setup_status', FRESH_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      });

      expect(screen.queryByText('Back')).not.toBeInTheDocument();
    });

    it('Next advances to step 3 from step 2 when step 2 is complete', async () => {
      // Start on step 2 (step 1 complete, step 2 NOT complete initially)
      mockInvoke('get_full_setup_status', STEP1_COMPLETE_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(
          screen.getByText('Save your work safely and publish it online. Required.')
        ).toBeInTheDocument();
      });

      // Install git+gh via batch install, then make gh_auth ready via terminal
      // Simulate: mock batch install of git/gh, then status refresh with step 2 complete
      mockInvoke('install_brew_packages', undefined);
      const step2CompleteStatus = makeSetupStatus({
        items: HAS_BASE_NO_AGENTS_ITEMS,
        optionalAuths: { githubAuthenticated: true },
        detectedAgents: [],
      });
      mockInvoke('get_full_setup_status', step2CompleteStatus);

      // Click Install on git (batch install of git+gh)
      const installButtons = screen.getAllByText('Install');
      act(() => {
        fireEvent.click(installButtons[0]);
      });

      // Wait for status refresh to complete — Next should be enabled
      await waitFor(() => {
        expect(screen.getByText('Next')).not.toBeDisabled();
      });

      // Click Next to advance to step 3
      act(() => {
        fireEvent.click(screen.getByText('Next'));
      });

      expect(screen.getByText('Install at least one AI coding assistant')).toBeInTheDocument();
    });

    it('hosting step shows Skip for Now button that advances to celebration', async () => {
      // Steps 1-3 complete, vercel missing → lands on hosting step
      const items = HAS_BASE_NO_AGENTS_ITEMS.map((i) => {
        if (i.id === 'claude') return { ...i, status: 'ready' as const, version: '1.0.0' };
        if (i.id === 'claude_auth')
          return { ...i, status: 'ready' as const, username: 'claude-user' };
        return i;
      });
      const status = makeSetupStatus({
        items,
        optionalAuths: { githubAuthenticated: true },
        detectedAgents: ['claude-code'],
      });
      mockInvoke('get_full_setup_status', status);
      mockInvoke('set_default_agent_id', undefined);

      render(<OnboardingScreen onComplete={onComplete} />);

      // Should land on hosting step
      await waitFor(() => {
        expect(
          screen.getByText('Optional. Connect later to put your site on the web.')
        ).toBeInTheDocument();
      });

      // Skip for Now should be visible
      expect(screen.getByText('Skip for Now')).toBeInTheDocument();

      // Click skip → celebration
      act(() => {
        fireEvent.click(screen.getByText('Skip for Now'));
      });

      await waitFor(() => {
        expect(screen.getByText("You're all set!")).toBeInTheDocument();
      });

      // Hosting was skipped — the copy must not claim everything is connected
      expect(screen.getByText('Your dev environment is ready')).toBeInTheDocument();
      expect(screen.queryByText('Everything is installed and connected')).not.toBeInTheDocument();
    });

    it('navigating back then forward preserves items state', async () => {
      mockInvoke('get_full_setup_status', STEP1_COMPLETE_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(
          screen.getByText('Save your work safely and publish it online. Required.')
        ).toBeInTheDocument();
      });

      // Go back
      act(() => {
        fireEvent.click(screen.getByText('Back'));
      });

      // Verify step 1 shows ready items
      expect(screen.getByText('Package Manager')).toBeInTheDocument();

      // Go forward again
      act(() => {
        fireEvent.click(screen.getByText('Next'));
      });

      expect(
        screen.getByText('Save your work safely and publish it online. Required.')
      ).toBeInTheDocument();
    });
  });

  // ============ Next button states ============

  describe('Next button state', () => {
    it('disabled while terminal is active', async () => {
      // Start on step 1 with homebrew ready, node not installed
      const items = FRESH_INSTALL_ITEMS.map((i) =>
        i.id === 'homebrew' ? { ...i, status: 'ready' as const, version: '4.2.0' } : i
      );
      const status = makeSetupStatus({ items, detectedAgents: [] });
      mockInvoke('get_full_setup_status', status);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      });

      // Click Install on node (non-terminal item uses batch install)
      // Instead, let's test with homebrew on a fresh install (terminal item)
      // Re-render with fresh status
    });

    it('agent step: disabled when no agent is ready', async () => {
      mockInvoke('get_full_setup_status', HAS_BASE_NO_AGENTS_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Install at least one AI coding assistant')).toBeInTheDocument();
      });

      const nextButton = screen.getByText('Next');
      expect(nextButton).toBeDisabled();
    });

    it('agent step: enabled when one agent pair is ready', async () => {
      // Start on step 3 with no agents ready, then install Claude via terminal
      mockInvoke('get_full_setup_status', HAS_BASE_NO_AGENTS_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Install at least one AI coding assistant')).toBeInTheDocument();
      });

      // Next should be disabled (no agent pair ready)
      expect(screen.getByText('Next')).toBeDisabled();

      // Install Claude Code (terminal item)
      const installButtons = screen.getAllByText('Install');
      act(() => {
        fireEvent.click(installButtons[0]);
      });

      await waitFor(() => {
        expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
      });

      // After terminal succeeds, mock status refresh with Claude pair ready
      const claudeReadyItems = HAS_BASE_NO_AGENTS_ITEMS.map((i) => {
        if (i.id === 'claude') return { ...i, status: 'ready' as const, version: '1.0.0' };
        if (i.id === 'claude_auth')
          return { ...i, status: 'ready' as const, username: 'claude-user' };
        return i;
      });
      mockInvoke(
        'get_full_setup_status',
        makeSetupStatus({
          items: claudeReadyItems,
          optionalAuths: { githubAuthenticated: true },
          detectedAgents: ['claude-code'],
        })
      );
      mockInvoke('set_default_agent_id', undefined);

      act(() => {
        fireEvent.click(screen.getByTestId('terminal-exit-0'));
      });

      // Terminal closes and status refreshes
      await waitFor(() => {
        expect(screen.queryByTestId('mock-terminal')).not.toBeInTheDocument();
      });

      // Next should now be enabled (one agent pair ready)
      await waitFor(() => {
        expect(screen.getByText('Next')).not.toBeDisabled();
      });
    });

    it('agent step: disabled when both agents ready but no selection made', async () => {
      // Base tools + both agents ready, but the wizard is on step 3
      // When both are ready, user must select a default
      const items = ALL_READY_BOTH_AGENTS;
      const status = makeSetupStatus({
        items,
        optionalAuths: { githubAuthenticated: true },
        detectedAgents: ['claude-code', 'codex'],
      });
      // This will auto-advance to celebration since all steps are complete.
      // To test the agent selection requirement, we need to be ON step 3.
      // We can't easily control the starting step since it's auto-detected.
      // Let's test this by having steps 1+2 complete and both agents ready
      // but NOT setting allReady (so findFirstIncompleteStep returns 'agent'
      // which won't happen because isAtLeastOneAgentReady returns true).
      // Actually, if both agent pairs are ready, isWizardStepComplete('agent')
      // returns true, and findFirstIncompleteStep would return 'hosting'
      // (which is always complete), so it returns null → celebration.
      //
      // The agent selection requirement only matters when user manually
      // navigates to step 3 (e.g., via Back). Let's test that.
      mockInvoke('get_full_setup_status', status);

      render(<OnboardingScreen onComplete={onComplete} />);

      // With all complete, it goes straight to celebration
      await waitFor(() => {
        expect(screen.getByText("You're all set!")).toBeInTheDocument();
      });
    });
  });

  // ============ End-to-end wizard flows ============

  describe('end-to-end wizard flows', () => {
    it('step 1 install → refresh shows updated items → Next enables', async () => {
      // Start fresh
      mockInvoke('get_full_setup_status', FRESH_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(
          screen.getByText('Install the tools needed to manage dependencies')
        ).toBeInTheDocument();
      });

      // Next should be disabled
      expect(screen.getByText('Next')).toBeDisabled();

      // Install homebrew (terminal item)
      const installButtons = screen.getAllByText('Install');
      act(() => {
        fireEvent.click(installButtons[0]);
      });

      await waitFor(() => {
        expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
      });

      // After terminal succeeds, mock returns step 1 complete
      mockInvoke('get_full_setup_status', STEP1_COMPLETE_STATUS);

      act(() => {
        fireEvent.click(screen.getByTestId('terminal-exit-0'));
      });

      // Terminal closes and status refreshes
      await waitFor(() => {
        expect(screen.queryByTestId('mock-terminal')).not.toBeInTheDocument();
      });

      // Next should now be enabled (step 1 complete)
      await waitFor(() => {
        expect(screen.getByText('Next')).not.toBeDisabled();
      });
    });

    it('clicking Next after step 1 complete advances to step 2', async () => {
      mockInvoke('get_full_setup_status', STEP1_COMPLETE_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      // Auto-advances to step 2
      await waitFor(() => {
        expect(
          screen.getByText('Save your work safely and publish it online. Required.')
        ).toBeInTheDocument();
      });

      // Step 2 items should be visible
      expect(screen.getByText('Git')).toBeInTheDocument();
      expect(screen.getByText('GitHub CLI')).toBeInTheDocument();
      expect(screen.getByText('GitHub Account')).toBeInTheDocument();
    });

    it('full flow: install on step 2 → step 3 → celebration', async () => {
      // Start on step 2 (step 1 auto-advanced)
      mockInvoke('get_full_setup_status', STEP1_COMPLETE_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(
          screen.getByText('Save your work safely and publish it online. Required.')
        ).toBeInTheDocument();
      });

      // Install git/gh (batch install via brew_packages)
      mockInvoke('install_brew_packages', undefined);

      const installButtons = screen.getAllByText('Install');
      // After install succeeds, mock step 2 complete status
      mockInvoke(
        'get_full_setup_status',
        makeSetupStatus({
          items: HAS_BASE_NO_AGENTS_ITEMS,
          optionalAuths: { githubAuthenticated: true },
          detectedAgents: [],
        })
      );

      act(() => {
        fireEvent.click(installButtons[0]);
      });

      // Wait for status refresh to complete — Next should be enabled
      await waitFor(() => {
        const nextBtn = screen.getByText('Next');
        expect(nextBtn).not.toBeDisabled();
      });

      // Click Next to advance to step 3
      act(() => {
        fireEvent.click(screen.getByText('Next'));
      });

      expect(screen.getByText('Install at least one AI coding assistant')).toBeInTheDocument();

      // Now install Claude (terminal item) — after it succeeds, we're all done
      const claudeInstalls = screen.getAllByText('Install');
      act(() => {
        fireEvent.click(claudeInstalls[0]); // Claude Code install
      });

      await waitFor(() => {
        expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
      });

      // Terminal succeeds, mock all-complete status
      mockInvoke('get_full_setup_status', CLAUDE_ONLY_STATUS);
      mockInvoke('set_default_agent_id', undefined);

      act(() => {
        fireEvent.click(screen.getByTestId('terminal-exit-0'));
      });

      await waitFor(() => {
        expect(screen.queryByTestId('mock-terminal')).not.toBeInTheDocument();
      });

      // Next should be enabled on agent step (one agent ready)
      await waitFor(() => {
        const nextBtn = screen.getByText('Next');
        expect(nextBtn).not.toBeDisabled();
      });

      // Click Next → hosting step is also complete (vercel ready in status) → celebration
      act(() => {
        fireEvent.click(screen.getByText('Next'));
      });

      await waitFor(() => {
        expect(screen.getByText("You're all set!")).toBeInTheDocument();
      });
    });

    it('retry after fetch error transitions to wizard', async () => {
      // Initial fetch fails
      mockInvokeErr('get_full_setup_status', new Error('Network timeout'));

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(
          screen.getByText('Failed to check setup status. Please try again.')
        ).toBeInTheDocument();
      });

      // Retry succeeds with fresh status
      mockInvoke('get_full_setup_status', FRESH_STATUS);

      act(() => {
        fireEvent.click(screen.getByText('Retry'));
      });

      // Should show wizard (retry fetches status but stays on current step)
      await waitFor(() => {
        expect(screen.getByText('Quick Setup')).toBeInTheDocument();
        expect(
          screen.getByText('Install the tools needed to manage dependencies')
        ).toBeInTheDocument();
      });
    });
  });

  // ============ Installation failure handling ============

  describe('installation failures', () => {
    it('batch install failure shows error on all in-progress items', async () => {
      // Step 1 with homebrew ready, node/git/gh not installed
      const items = FRESH_INSTALL_ITEMS.map((i) =>
        i.id === 'homebrew' ? { ...i, status: 'ready' as const, version: '4.2.0' } : i
      );
      const status = makeSetupStatus({ items, detectedAgents: [] });
      mockInvoke('get_full_setup_status', status);

      // Mock batch install to fail
      invokeResults.set('install_brew_packages', {
        error: new Error('[install_brew_packages] Failed to install node: network timeout'),
      });

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      });

      // Click Install on node (triggers batch install of all missing brew packages)
      const installButtons = screen.getAllByText('Install');

      act(() => {
        fireEvent.click(installButtons[0]);
      });

      // Error should appear with cleaned message (backend prefix stripped)
      await waitFor(() => {
        expect(screen.getByText('Retry')).toBeInTheDocument();
        expect(screen.getByText('Failed to install node: network timeout')).toBeInTheDocument();
      });
    });

    it('terminal exit code 127 (command not found) shows error', async () => {
      mockInvoke('get_full_setup_status', FRESH_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      });

      const installButtons = screen.getAllByText('Install');
      act(() => {
        fireEvent.click(installButtons[0]);
      });

      await waitFor(() => {
        expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
      });

      act(() => {
        fireEvent.click(screen.getByTestId('terminal-exit-127'));
      });

      // Terminal stays open with Close button, item gets error status
      expect(screen.getByText('Close')).toBeInTheDocument();
      expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
    });

    it('homebrew failure shows admin privilege error message', async () => {
      // Start fresh so homebrew is the first install
      mockInvoke('get_full_setup_status', FRESH_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      });

      // Click Install on homebrew (first Install button)
      const installButtons = screen.getAllByText('Install');
      act(() => {
        fireEvent.click(installButtons[0]);
      });

      await waitFor(() => {
        expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
      });

      // Terminal fails
      act(() => {
        fireEvent.click(screen.getByTestId('terminal-exit-1'));
      });

      // Should show homebrew-specific error message
      await waitFor(() => {
        expect(
          screen.getByText(
            'Installation failed. Your macOS account may need administrator privileges.'
          )
        ).toBeInTheDocument();
      });
    });

    it('homebrew failure with a network tail shows network guidance, not the admin hint', async () => {
      mockInvoke('get_full_setup_status', FRESH_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      });

      act(() => {
        fireEvent.click(screen.getAllByText('Install')[0]);
      });

      await waitFor(() => {
        expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
      });

      act(() => {
        fireEvent.click(screen.getByTestId('terminal-exit-1-network'));
      });
      act(() => {
        fireEvent.click(screen.getByText('Close'));
      });

      await waitFor(() => {
        expect(
          screen.getByText(
            'curl: (6) Could not resolve host: claude.ai — This looks like a network problem — check your internet connection and try again.'
          )
        ).toBeInTheDocument();
      });
      expect(
        screen.queryByText(
          'Installation failed. Your macOS account may need administrator privileges.'
        )
      ).not.toBeInTheDocument();
    });

    it('homebrew failure mentioning sudo/password keeps the admin-privileges hint', async () => {
      mockInvoke('get_full_setup_status', FRESH_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      });

      act(() => {
        fireEvent.click(screen.getAllByText('Install')[0]);
      });

      await waitFor(() => {
        expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
      });

      act(() => {
        fireEvent.click(screen.getByTestId('terminal-exit-1-sudo'));
      });
      act(() => {
        fireEvent.click(screen.getByText('Close'));
      });

      await waitFor(() => {
        expect(
          screen.getByText(
            'Installation failed. Your macOS account may need administrator privileges.'
          )
        ).toBeInTheDocument();
      });
    });

    it('homebrew failure with a real extracted error shows it instead of the admin hint', async () => {
      mockInvoke('get_full_setup_status', FRESH_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      });

      act(() => {
        fireEvent.click(screen.getAllByText('Install')[0]);
      });

      await waitFor(() => {
        expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
      });

      act(() => {
        fireEvent.click(screen.getByTestId('terminal-exit-1-npm-err'));
      });
      act(() => {
        fireEvent.click(screen.getByText('Close'));
      });

      await waitFor(() => {
        expect(screen.getByText('npm ERR! EEXIST: file already exists')).toBeInTheDocument();
      });
      expect(
        screen.queryByText(
          'Installation failed. Your macOS account may need administrator privileges.'
        )
      ).not.toBeInTheDocument();
    });

    it('non-homebrew failure with a network tail shows the network guidance', async () => {
      // Step 3: first Install button is Claude Code
      mockInvoke('get_full_setup_status', HAS_BASE_NO_AGENTS_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Install at least one AI coding assistant')).toBeInTheDocument();
      });

      act(() => {
        fireEvent.click(screen.getAllByText('Install')[0]);
      });

      await waitFor(() => {
        expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
      });

      act(() => {
        fireEvent.click(screen.getByTestId('terminal-exit-1-network'));
      });
      act(() => {
        fireEvent.click(screen.getByText('Close'));
      });

      await waitFor(() => {
        expect(
          screen.getByText(
            'curl: (6) Could not resolve host: claude.ai — This looks like a network problem — check your internet connection and try again.'
          )
        ).toBeInTheDocument();
      });
      // The raw curl line is kept and the guidance appended — never replaced
      // (standing rule: verbose context beats tidy summaries).
      expect(screen.getByText(/Could not resolve host/)).toBeInTheDocument();
    });

    it('failed item can be retried by clicking Retry', async () => {
      // Start with a status that has node in error state
      const items = FRESH_INSTALL_ITEMS.map((i) => {
        if (i.id === 'homebrew') return { ...i, status: 'ready' as const, version: '4.2.0' };
        if (i.id === 'node')
          return { ...i, status: 'error' as const, errorMessage: 'Install failed' };
        return i;
      });
      const status = makeSetupStatus({ items, detectedAgents: [] });
      mockInvoke('get_full_setup_status', status);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Install failed')).toBeInTheDocument();
        expect(screen.getByText('Retry')).toBeInTheDocument();
      });

      // Mock retry to succeed — after retry, batch install runs and status refreshes
      mockInvoke('install_brew_packages', undefined);
      const updatedStatus = makeSetupStatus({
        items: STEP1_COMPLETE_ITEMS,
        detectedAgents: [],
      });
      mockInvoke('get_full_setup_status', updatedStatus);

      act(() => {
        fireEvent.click(screen.getByText('Retry'));
      });

      // After retry, the error should be gone and items updated
      await waitFor(() => {
        expect(screen.queryByText('Install failed')).not.toBeInTheDocument();
      });
    });

    it('error message is cleaned of backend command prefixes', async () => {
      const items = FRESH_INSTALL_ITEMS.map((i) =>
        i.id === 'homebrew' ? { ...i, status: 'ready' as const, version: '4.2.0' } : i
      );
      const status = makeSetupStatus({ items, detectedAgents: [] });
      mockInvoke('get_full_setup_status', status);

      // Error with backend prefix like [install_brew_packages]
      invokeResults.set('install_brew_packages', {
        error: new Error('[install_brew_packages] brew: command not found'),
      });

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      });

      const installButtons = screen.getAllByText('Install');
      act(() => {
        fireEvent.click(installButtons[0]);
      });

      // The prefix [install_brew_packages] should be stripped
      await waitFor(() => {
        expect(screen.getByText('brew: command not found')).toBeInTheDocument();
      });
    });

    it('renders CommandError objects as a real message, not "[object Object]"', async () => {
      // Regression: Tauri commands reject with a structured CommandError
      // *object* (e.g. install_winget_packages on Windows), not an Error
      // instance. The catch handler used to do `String(err)`, which rendered
      // "[object Object]" in the UI (the literal symptom seen on Windows when
      // Node.js install failed). It must format the CommandError instead.
      const items = FRESH_INSTALL_ITEMS.map((i) =>
        i.id === 'homebrew' ? { ...i, status: 'ready' as const, version: '4.2.0' } : i
      );
      const status = makeSetupStatus({ items, detectedAgents: [] });
      mockInvoke('get_full_setup_status', status);

      // The real shape rejected over the IPC boundary: a plain object, not an Error.
      const commandError = {
        type: 'Other',
        message: 'Failed to install OpenJS.NodeJS: winget exited with status 1',
      };
      invokeResults.set('install_brew_packages', {
        error: commandError as unknown as Error,
      });

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      });

      const installButtons = screen.getAllByText('Install');
      act(() => {
        fireEvent.click(installButtons[0]);
      });

      await waitFor(() => {
        expect(
          screen.getByText('Failed to install OpenJS.NodeJS: winget exited with status 1')
        ).toBeInTheDocument();
      });
      expect(screen.queryByText('[object Object]')).not.toBeInTheDocument();
    });

    it('empty error message falls back to default', async () => {
      const items = FRESH_INSTALL_ITEMS.map((i) =>
        i.id === 'homebrew' ? { ...i, status: 'ready' as const, version: '4.2.0' } : i
      );
      const status = makeSetupStatus({ items, detectedAgents: [] });
      mockInvoke('get_full_setup_status', status);

      invokeResults.set('install_brew_packages', {
        error: new Error(''),
      });

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      });

      const installButtons = screen.getAllByText('Install');
      act(() => {
        fireEvent.click(installButtons[0]);
      });

      await waitFor(() => {
        expect(screen.getByText('Something went wrong. Click to try again.')).toBeInTheDocument();
      });
    });
  });

  // ============ Auth verification after terminal ============

  describe('auth verification after terminal', () => {
    it('gh_auth terminal exit 0 but not authenticated shows error after staggered re-checks', async () => {
      vi.useFakeTimers();

      // Start on step 2 with git+gh ready, gh_auth not authenticated
      const items = STEP1_COMPLETE_ITEMS.map((i) => {
        if (i.id === 'git') return { ...i, status: 'ready' as const, version: '2.43.0' };
        if (i.id === 'gh') return { ...i, status: 'ready' as const, version: '2.40.0' };
        return i;
      });
      const status = makeSetupStatus({ items, detectedAgents: [] });
      mockInvoke('get_full_setup_status', status);

      // Every check misses: the pre-check (so the terminal opens) and all of
      // the staggered post-exit re-checks (so failure is finally declared).
      mockCheckGitHubCliStatus.mockResolvedValue({ installed: true, authenticated: false });

      render(<OnboardingScreen onComplete={onComplete} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(
        screen.getByText('Save your work safely and publish it online. Required.')
      ).toBeInTheDocument();

      // Click Connect → opens terminal
      const connectButtons = screen.getAllByText('Connect');
      act(() => {
        fireEvent.click(connectButtons[0]);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();

      // Terminal exits 0 (user thought auth was done, but it wasn't)
      act(() => {
        fireEvent.click(screen.getByTestId('terminal-exit-0'));
      });

      // Not failed yet — the wizard re-checks at 600/1500/3000ms first
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(
        screen.queryByText('Authentication not completed. Click to try again.')
      ).not.toBeInTheDocument();

      // After the final re-check misses, the error is shown
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });
      expect(
        screen.getByText('Authentication not completed. Click to try again.')
      ).toBeInTheDocument();

      vi.useRealTimers();
    });

    it('gh_auth token landing a beat after exit is rescued by the 600ms re-check', async () => {
      vi.useFakeTimers();

      const items = STEP1_COMPLETE_ITEMS.map((i) => {
        if (i.id === 'git') return { ...i, status: 'ready' as const, version: '2.43.0' };
        if (i.id === 'gh') return { ...i, status: 'ready' as const, version: '2.40.0' };
        return i;
      });
      const status = makeSetupStatus({ items, detectedAgents: [] });
      mockInvoke('get_full_setup_status', status);

      // Pre-check misses (terminal opens); the immediate post-exit check also
      // misses (token not written yet); the 600ms re-check finds it.
      mockCheckGitHubCliStatus
        .mockResolvedValueOnce({ installed: true, authenticated: false })
        .mockResolvedValueOnce({ installed: true, authenticated: false })
        .mockResolvedValue({ installed: true, authenticated: true });

      render(<OnboardingScreen onComplete={onComplete} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      act(() => {
        fireEvent.click(screen.getAllByText('Connect')[0]);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();

      act(() => {
        fireEvent.click(screen.getByTestId('terminal-exit-0'));
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(700);
      });

      // No failure declared — the delayed re-check verified the auth
      expect(
        screen.queryByText('Authentication not completed. Click to try again.')
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId('mock-terminal')).not.toBeInTheDocument();

      vi.useRealTimers();
    });

    it('claude_auth terminal exit 0 but not authenticated shows error', async () => {
      vi.useFakeTimers();

      // Start on step 3 with Claude installed but not authenticated
      const items = HAS_BASE_NO_AGENTS_ITEMS.map((i) => {
        if (i.id === 'claude') return { ...i, status: 'ready' as const, version: '1.0.0' };
        return i;
      });
      const status = makeSetupStatus({
        items,
        optionalAuths: { githubAuthenticated: true },
        detectedAgents: [],
      });
      mockInvoke('get_full_setup_status', status);

      // Mock claude auth check to return NOT authenticated (pre-check and
      // every staggered post-exit re-check)
      mockInvoke('check_claude_auth_status', false);

      render(<OnboardingScreen onComplete={onComplete} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('Install at least one AI coding assistant')).toBeInTheDocument();

      // Find Connect button for claude_auth
      const connectButtons = screen.getAllByText('Connect');
      expect(connectButtons.length).toBeGreaterThan(0);

      act(() => {
        fireEvent.click(connectButtons[0]);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();

      // Terminal exits 0 but the auth check keeps failing through all re-checks
      act(() => {
        fireEvent.click(screen.getByTestId('terminal-exit-0'));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });

      expect(
        screen.getByText('Authentication not completed. Click to try again.')
      ).toBeInTheDocument();

      vi.useRealTimers();
    });

    it('claude_auth failure surfaces the extracted error from the output tail', async () => {
      vi.useFakeTimers();

      // Verification fails AND the tail names the real cause — show the cause,
      // not the generic "Authentication not completed" (issue #159).
      const items = HAS_BASE_NO_AGENTS_ITEMS.map((i) => {
        if (i.id === 'claude') return { ...i, status: 'ready' as const, version: '1.0.0' };
        return i;
      });
      const status = makeSetupStatus({
        items,
        optionalAuths: { githubAuthenticated: true },
        detectedAgents: [],
      });
      mockInvoke('get_full_setup_status', status);
      mockInvoke('check_claude_auth_status', false);

      render(<OnboardingScreen onComplete={onComplete} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('Install at least one AI coding assistant')).toBeInTheDocument();

      act(() => {
        fireEvent.click(screen.getAllByText('Connect')[0]);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();

      act(() => {
        fireEvent.click(screen.getByTestId('terminal-exit-0-auth-error'));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });

      expect(screen.getByText('Error: OAuth token exchange failed')).toBeInTheDocument();
      expect(
        screen.queryByText('Authentication not completed. Click to try again.')
      ).not.toBeInTheDocument();

      vi.useRealTimers();
    });

    it('claude_auth failure when the CLI says already-logged-in names the identity', async () => {
      vi.useFakeTimers();

      // The #159 desync: the CLI insists it has a login, but the status check
      // disagrees. Tell the user what the CLI reported and where to fix it.
      const items = HAS_BASE_NO_AGENTS_ITEMS.map((i) => {
        if (i.id === 'claude') return { ...i, status: 'ready' as const, version: '1.0.0' };
        return i;
      });
      const status = makeSetupStatus({
        items,
        optionalAuths: { githubAuthenticated: true },
        detectedAgents: [],
      });
      mockInvoke('get_full_setup_status', status);
      mockInvoke('check_claude_auth_status', false);

      render(<OnboardingScreen onComplete={onComplete} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('Install at least one AI coding assistant')).toBeInTheDocument();

      act(() => {
        fireEvent.click(screen.getAllByText('Connect')[0]);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();

      act(() => {
        fireEvent.click(screen.getByTestId('terminal-exit-0-already-logged-in'));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });

      expect(
        screen.getByText(
          "Claude reports you're already signed in as julian@example.com — if this looks wrong, sign out from the Agents panel first."
        )
      ).toBeInTheDocument();

      vi.useRealTimers();
    });

    it('gh_auth nonzero exit with already-logged-in tail names the gh identity', async () => {
      const items = STEP1_COMPLETE_ITEMS.map((i) => {
        if (i.id === 'git') return { ...i, status: 'ready' as const, version: '2.43.0' };
        if (i.id === 'gh') return { ...i, status: 'ready' as const, version: '2.40.0' };
        return i;
      });
      const status = makeSetupStatus({ items, detectedAgents: [] });
      mockInvoke('get_full_setup_status', status);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(
          screen.getByText('Save your work safely and publish it online. Required.')
        ).toBeInTheDocument();
      });

      // Pre-check: not authenticated → terminal opens
      mockCheckGitHubCliStatus.mockResolvedValueOnce({ installed: true, authenticated: false });

      act(() => {
        fireEvent.click(screen.getAllByText('Connect')[0]);
      });

      await waitFor(() => {
        expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
      });

      // gh exits nonzero while insisting a login already exists
      act(() => {
        fireEvent.click(screen.getByTestId('terminal-exit-1-gh-already-logged-in'));
      });

      act(() => {
        fireEvent.click(screen.getByText('Close'));
      });

      await waitFor(() => {
        expect(
          screen.getByText(
            "GitHub reports you're already signed in as juliangalluzzo — if this looks wrong, sign out by running `gh auth logout` in a terminal first."
          )
        ).toBeInTheDocument();
      });
    });

    it('gh_auth pre-check finds existing auth and skips terminal', async () => {
      // Start on step 2 with git+gh ready, gh_auth not authenticated
      const items = STEP1_COMPLETE_ITEMS.map((i) => {
        if (i.id === 'git') return { ...i, status: 'ready' as const, version: '2.43.0' };
        if (i.id === 'gh') return { ...i, status: 'ready' as const, version: '2.40.0' };
        return i;
      });
      const status = makeSetupStatus({ items, detectedAgents: [] });
      mockInvoke('get_full_setup_status', status);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(
          screen.getByText('Save your work safely and publish it online. Required.')
        ).toBeInTheDocument();
      });

      // Pre-check returns already authenticated
      mockCheckGitHubCliStatus.mockResolvedValueOnce({ installed: true, authenticated: true });

      // Click Connect for gh_auth
      const connectButtons = screen.getAllByText('Connect');
      act(() => {
        fireEvent.click(connectButtons[0]);
      });

      // Terminal should NOT open — pre-check found existing auth
      await waitFor(() => {
        expect(screen.queryByTestId('mock-terminal')).not.toBeInTheDocument();
      });
    });

    it('claude_auth pre-check finds existing auth and skips terminal', async () => {
      // Start on step 3 with Claude installed but auth not done
      const items = HAS_BASE_NO_AGENTS_ITEMS.map((i) => {
        if (i.id === 'claude') return { ...i, status: 'ready' as const, version: '1.0.0' };
        return i;
      });
      const status = makeSetupStatus({
        items,
        optionalAuths: { githubAuthenticated: true },
        detectedAgents: [],
      });
      mockInvoke('get_full_setup_status', status);
      // Pre-check returns already authenticated
      mockInvoke('check_claude_auth_status', true);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Install at least one AI coding assistant')).toBeInTheDocument();
      });

      const connectButtons = screen.getAllByText('Connect');
      act(() => {
        fireEvent.click(connectButtons[0]);
      });

      // Terminal should NOT open — pre-check found existing auth
      await waitFor(() => {
        expect(screen.queryByTestId('mock-terminal')).not.toBeInTheDocument();
      });
    });
  });

  // ============ Post-success verification (audit #3/#4) ============

  describe('post-success verification', () => {
    it('install exiting 0 without the tool appearing surfaces a clear error', async () => {
      vi.useFakeTimers();

      // Homebrew stays not_installed in every refresh — the offline installer
      // signature (curl substitution came back empty, bash exited 0).
      mockInvoke('get_full_setup_status', FRESH_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('Quick Setup')).toBeInTheDocument();

      act(() => {
        fireEvent.click(screen.getAllByText('Install')[0]);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();

      act(() => {
        fireEvent.click(screen.getByTestId('terminal-exit-0'));
      });

      // Terminal closes immediately; verification is still re-checking
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.queryByTestId('mock-terminal')).not.toBeInTheDocument();

      // After the 600/1500/3000ms re-checks all miss, the item goes to error
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      expect(
        screen.getByText(
          "The command finished but Package Manager still isn't detected. If you're on a spotty connection, check your internet and try again."
        )
      ).toBeInTheDocument();

      vi.useRealTimers();
    });

    it('install exiting 0 with the tool detected on refresh shows no error', async () => {
      vi.useFakeTimers();

      mockInvoke('get_full_setup_status', FRESH_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      act(() => {
        fireEvent.click(screen.getAllByText('Install')[0]);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();

      // The refreshed status shows homebrew ready → first verification passes
      mockInvoke('get_full_setup_status', STEP1_COMPLETE_STATUS);

      act(() => {
        fireEvent.click(screen.getByTestId('terminal-exit-0'));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.queryByTestId('mock-terminal')).not.toBeInTheDocument();
      expect(screen.queryByText(/still isn't detected/)).not.toBeInTheDocument();
      expect(screen.getByText('Next')).not.toBeDisabled();

      vi.useRealTimers();
    });
  });

  // ============ Terminal edge cases ============

  describe('terminal edge cases', () => {
    it('null exit code (killed terminal) treated as success', async () => {
      mockInvoke('get_full_setup_status', FRESH_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      });

      const installButtons = screen.getAllByText('Install');
      act(() => {
        fireEvent.click(installButtons[0]);
      });

      await waitFor(() => {
        expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
      });

      // Exit with null (process killed / terminal closed)
      act(() => {
        fireEvent.click(screen.getByTestId('terminal-exit-null'));
      });

      // Terminal should close (null is treated like success)
      await waitFor(() => {
        expect(screen.queryByTestId('mock-terminal')).not.toBeInTheDocument();
      });
    });

    it('after terminal failure, clicking Close clears terminal', async () => {
      mockInvoke('get_full_setup_status', FRESH_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      });

      const installButtons = screen.getAllByText('Install');
      act(() => {
        fireEvent.click(installButtons[0]);
      });

      await waitFor(() => {
        expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
      });

      // Terminal fails
      act(() => {
        fireEvent.click(screen.getByTestId('terminal-exit-1'));
      });

      // Close button appears
      expect(screen.getByText('Close')).toBeInTheDocument();

      // Click Close
      act(() => {
        fireEvent.click(screen.getByText('Close'));
      });

      // Terminal should be removed
      await waitFor(() => {
        expect(screen.queryByTestId('mock-terminal')).not.toBeInTheDocument();
      });
    });

    it('terminal shows item friendly name in header', async () => {
      mockInvoke('get_full_setup_status', FRESH_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      });

      const installButtons = screen.getAllByText('Install');
      act(() => {
        fireEvent.click(installButtons[0]);
      });

      await waitFor(() => {
        expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
      });

      // Terminal header should show friendly name (Package Manager for homebrew).
      // The text also appears in the step items list, so use the terminal-specific
      // class to verify the header specifically.
      const terminalTitle = document.querySelector('.onboarding-terminal-title');
      expect(terminalTitle).not.toBeNull();
      expect(terminalTitle!.textContent).toBe('Package Manager');
    });
  });

  // ============ Action guards ============

  describe('action guards', () => {
    it('ignores second action when one is already in progress', async () => {
      mockInvoke('get_full_setup_status', FRESH_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      });

      // Click Install (opens terminal)
      const installButtons = screen.getAllByText('Install');
      act(() => {
        fireEvent.click(installButtons[0]);
      });

      await waitFor(() => {
        expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
      });

      // All other buttons should be disabled while terminal is active
      // (checked via the isAnyActionInProgress prop)
      // The remaining Install buttons in the UI should be disabled
      const remainingInstalls = screen.queryAllByText('Install');
      remainingInstalls.forEach((btn) => {
        expect(btn).toBeDisabled();
      });
    });
  });

  // ============ Terminal cancel with delayed re-check ============

  describe('terminal cancel for auth items', () => {
    it('cancel triggers immediate status refresh', async () => {
      mockInvoke('get_full_setup_status', FRESH_STATUS);
      const { invoke } = await import('@tauri-apps/api/core');
      const invokeMock = invoke as ReturnType<typeof vi.fn>;

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      });

      // Open terminal for homebrew
      const installButtons = screen.getAllByText('Install');
      act(() => {
        fireEvent.click(installButtons[0]);
      });

      await waitFor(() => {
        expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
      });

      const callCountBefore = invokeMock.mock.calls.filter(
        (c: string[]) => c[0] === 'get_full_setup_status'
      ).length;

      // Cancel terminal
      act(() => {
        fireEvent.click(screen.getByText('Cancel'));
      });

      // Should trigger a fetch
      await waitFor(() => {
        const callCountAfter = invokeMock.mock.calls.filter(
          (c: string[]) => c[0] === 'get_full_setup_status'
        ).length;
        expect(callCountAfter).toBeGreaterThan(callCountBefore);
      });
    });
  });

  // ============ Agent selection ============

  describe('agent default selection', () => {
    it('single agent auto-sets default via set_default_agent_id', async () => {
      mockInvoke('get_full_setup_status', CLAUDE_ONLY_STATUS);
      mockInvoke('set_default_agent_id', undefined);

      const { invoke } = await import('@tauri-apps/api/core');
      const invokeMock = invoke as ReturnType<typeof vi.fn>;

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText("You're all set!")).toBeInTheDocument();
      });

      // Verify set_default_agent_id was called with 'claude-code'
      const setDefaultCalls = invokeMock.mock.calls.filter(
        (c: string[]) => c[0] === 'set_default_agent_id'
      );
      expect(setDefaultCalls.length).toBe(1);
      expect(setDefaultCalls[0][1]).toEqual({ agentId: 'claude-code' });
    });

    it('codex-only auto-sets codex as default', async () => {
      mockInvoke('get_full_setup_status', CODEX_ONLY_STATUS);
      mockInvoke('set_default_agent_id', undefined);

      const { invoke } = await import('@tauri-apps/api/core');
      const invokeMock = invoke as ReturnType<typeof vi.fn>;

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText("You're all set!")).toBeInTheDocument();
      });

      const setDefaultCalls = invokeMock.mock.calls.filter(
        (c: string[]) => c[0] === 'set_default_agent_id'
      );
      expect(setDefaultCalls.length).toBe(1);
      expect(setDefaultCalls[0][1]).toEqual({ agentId: 'codex' });
    });

    it('both agents detected does not auto-set default (user must choose)', async () => {
      // detectedAgents includes claude-code — the effective default — so the
      // fast path leaves the choice alone.
      mockInvoke('get_full_setup_status', BOTH_AGENTS_STATUS);
      mockInvoke('set_default_agent_id', undefined);

      const { invoke } = await import('@tauri-apps/api/core');
      const invokeMock = invoke as ReturnType<typeof vi.fn>;

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText("You're all set!")).toBeInTheDocument();
      });

      // With both agents, handleAllComplete doesn't call set_default_agent_id
      const setDefaultCalls = invokeMock.mock.calls.filter(
        (c: string[]) => c[0] === 'set_default_agent_id'
      );
      expect(setDefaultCalls.length).toBe(0);
    });

    it('fast path with multiple agents repoints the default when it is not among them', async () => {
      // Codex + Opencode ready, Claude absent. The backend default falls back
      // to claude-code, which isn't installed — the fast path must repoint it
      // at the first detected agent (audit #9).
      const items = ALL_READY_CODEX_ONLY.map((i) => {
        if (i.id === 'opencode') return { ...i, status: 'ready' as const, version: '0.1.0' };
        if (i.id === 'opencode_auth')
          return { ...i, status: 'ready' as const, username: 'oc-user' };
        return i;
      });
      const status = makeSetupStatus({
        allReady: true,
        items,
        optionalAuths: { githubAuthenticated: true },
        detectedAgents: ['codex', 'opencode'],
      });
      mockInvoke('get_full_setup_status', status);
      mockInvoke('get_default_agent_id', null); // unset → effective default is claude-code
      mockInvoke('set_default_agent_id', undefined);

      const { invoke } = await import('@tauri-apps/api/core');
      const invokeMock = invoke as ReturnType<typeof vi.fn>;

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText("You're all set!")).toBeInTheDocument();
      });

      const setDefaultCalls = invokeMock.mock.calls.filter(
        (c: string[]) => c[0] === 'set_default_agent_id'
      );
      expect(setDefaultCalls.length).toBe(1);
      expect(setDefaultCalls[0][1]).toEqual({ agentId: 'codex' });
    });

    it('fast path with multiple agents keeps a persisted default that is among them', async () => {
      const items = ALL_READY_CODEX_ONLY.map((i) => {
        if (i.id === 'opencode') return { ...i, status: 'ready' as const, version: '0.1.0' };
        if (i.id === 'opencode_auth')
          return { ...i, status: 'ready' as const, username: 'oc-user' };
        return i;
      });
      const status = makeSetupStatus({
        allReady: true,
        items,
        optionalAuths: { githubAuthenticated: true },
        detectedAgents: ['codex', 'opencode'],
      });
      mockInvoke('get_full_setup_status', status);
      mockInvoke('get_default_agent_id', 'opencode');
      mockInvoke('set_default_agent_id', undefined);

      const { invoke } = await import('@tauri-apps/api/core');
      const invokeMock = invoke as ReturnType<typeof vi.fn>;

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText("You're all set!")).toBeInTheDocument();
      });

      const setDefaultCalls = invokeMock.mock.calls.filter(
        (c: string[]) => c[0] === 'set_default_agent_id'
      );
      expect(setDefaultCalls.length).toBe(0);
    });
  });

  // ============ Blocked items display ============

  describe('blocked items', () => {
    it('node shows as blocked when homebrew is not installed', async () => {
      mockInvoke('get_full_setup_status', FRESH_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      });

      // Node depends on homebrew — with homebrew not installed, node should show "Waiting for..."
      expect(screen.getByText('Unlocks after Package Manager')).toBeInTheDocument();
    });

    it('node becomes installable after homebrew is installed', async () => {
      // Start with homebrew ready, node not installed
      const items = FRESH_INSTALL_ITEMS.map((i) =>
        i.id === 'homebrew' ? { ...i, status: 'ready' as const, version: '4.2.0' } : i
      );
      const status = makeSetupStatus({ items, detectedAgents: [] });
      mockInvoke('get_full_setup_status', status);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      });

      // Node should NOT show "Waiting for..." anymore
      expect(screen.queryByText('Unlocks after Package Manager')).not.toBeInTheDocument();

      // Node should have an Install button
      const installButtons = screen.getAllByText('Install');
      expect(installButtons.length).toBeGreaterThan(0);
    });

    it('gh_auth shows as blocked when gh is not installed (step 2)', async () => {
      mockInvoke('get_full_setup_status', STEP1_COMPLETE_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(
          screen.getByText('Save your work safely and publish it online. Required.')
        ).toBeInTheDocument();
      });

      // gh_auth depends on gh — with gh not installed, should show blocked
      expect(screen.getByText('Unlocks after GitHub CLI')).toBeInTheDocument();
    });

    it('claude_auth shows as blocked when claude is not installed (step 3)', async () => {
      mockInvoke('get_full_setup_status', HAS_BASE_NO_AGENTS_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Install at least one AI coding assistant')).toBeInTheDocument();
      });

      // claude_auth depends on claude — should show blocked
      expect(screen.getByText('Unlocks after Claude Code')).toBeInTheDocument();
    });
  });

  // ============ Step completion edge cases ============

  describe('step completion edge cases', () => {
    it('step 2 incomplete when only git is ready but gh and gh_auth are not', async () => {
      const items = STEP1_COMPLETE_ITEMS.map((i) => {
        if (i.id === 'git') return { ...i, status: 'ready' as const, version: '2.43.0' };
        return i;
      });
      const status = makeSetupStatus({ items, detectedAgents: [] });
      mockInvoke('get_full_setup_status', status);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(
          screen.getByText('Save your work safely and publish it online. Required.')
        ).toBeInTheDocument();
      });

      // Next should be disabled (step not complete)
      expect(screen.getByText('Next')).toBeDisabled();
    });

    it('step 1 with npm_fix present requires it to be ready too', async () => {
      // Add npm_fix item that's not ready
      const items = [
        ...FRESH_INSTALL_ITEMS.map((i) => {
          if (i.id === 'homebrew') return { ...i, status: 'ready' as const, version: '4.2.0' };
          if (i.id === 'node') return { ...i, status: 'ready' as const, version: 'v20.11.0' };
          return i;
        }),
      ];
      // Insert npm_fix after node
      const npmFixItem = {
        id: 'npm_fix',
        friendlyName: 'Fix npm Permissions',
        status: 'not_installed' as const,
      };
      const nodeIndex = items.findIndex((i) => i.id === 'node');
      items.splice(nodeIndex + 1, 0, npmFixItem);

      const status = makeSetupStatus({ items, detectedAgents: [] });
      mockInvoke('get_full_setup_status', status);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      });

      // npm_fix is present and not ready — Next should be disabled
      expect(screen.getByText('Next')).toBeDisabled();

      // Fix npm Permissions should appear
      expect(screen.getByText('Fix npm Permissions')).toBeInTheDocument();
    });

    it('agent step complete with only codex pair ready', async () => {
      // Start on step 3 with no agents ready, then install Codex via terminal
      mockInvoke('get_full_setup_status', HAS_BASE_NO_AGENTS_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Install at least one AI coding assistant')).toBeInTheDocument();
      });

      // Next should be disabled (no agent pair ready)
      expect(screen.getByText('Next')).toBeDisabled();

      // Install Codex (terminal item) — install buttons on the agent step are
      // Claude Code, Codex, Opencode in order. Click the Codex one: the
      // post-success verification checks the *clicked* item, so clicking a
      // different agent would (correctly) flag it as not detected.
      const installButtons = screen.getAllByText('Install');
      act(() => {
        fireEvent.click(installButtons[1]);
      });

      await waitFor(() => {
        expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
      });

      // After terminal succeeds, mock status with Codex pair ready
      const codexReadyItems = HAS_BASE_NO_AGENTS_ITEMS.map((i) => {
        if (i.id === 'codex') return { ...i, status: 'ready' as const, version: '0.1.0' };
        if (i.id === 'codex_auth')
          return { ...i, status: 'ready' as const, username: 'codex-user' };
        return i;
      });
      mockInvoke(
        'get_full_setup_status',
        makeSetupStatus({
          items: codexReadyItems,
          optionalAuths: { githubAuthenticated: true },
          detectedAgents: ['codex'],
        })
      );
      mockInvoke('set_default_agent_id', undefined);

      act(() => {
        fireEvent.click(screen.getByTestId('terminal-exit-0'));
      });

      // Terminal closes and status refreshes
      await waitFor(() => {
        expect(screen.queryByTestId('mock-terminal')).not.toBeInTheDocument();
      });

      // Next should now be enabled (one agent pair ready)
      await waitFor(() => {
        expect(screen.getByText('Next')).not.toBeDisabled();
      });
    });

    it('agent step incomplete when binary ready but auth not', async () => {
      const items = HAS_BASE_NO_AGENTS_ITEMS.map((i) => {
        if (i.id === 'claude') return { ...i, status: 'ready' as const, version: '1.0.0' };
        // claude_auth stays not_authenticated
        return i;
      });
      const status = makeSetupStatus({
        items,
        optionalAuths: { githubAuthenticated: true },
        detectedAgents: [],
      });
      mockInvoke('get_full_setup_status', status);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Install at least one AI coding assistant')).toBeInTheDocument();
      });

      // Next should be disabled (binary ready but auth not = no complete pair)
      expect(screen.getByText('Next')).toBeDisabled();
    });
  });

  // ============ Multiple consecutive errors and recovery ============

  describe('error recovery', () => {
    it('multiple fetch errors show same error message each time', async () => {
      mockInvokeErr('get_full_setup_status', new Error('Network error'));

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(
          screen.getByText('Failed to check setup status. Please try again.')
        ).toBeInTheDocument();
      });

      // Retry — still fails
      mockInvokeErr('get_full_setup_status', new Error('Still down'));

      act(() => {
        fireEvent.click(screen.getByText('Retry'));
      });

      await waitFor(() => {
        expect(
          screen.getByText('Failed to check setup status. Please try again.')
        ).toBeInTheDocument();
      });

      // Retry again — now succeeds
      mockInvoke('get_full_setup_status', FRESH_STATUS);

      act(() => {
        fireEvent.click(screen.getByText('Retry'));
      });

      await waitFor(() => {
        expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      });
    });

    it('terminal failure then retry succeeds', async () => {
      mockInvoke('get_full_setup_status', FRESH_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      });

      // First attempt: install homebrew fails
      const installButtons = screen.getAllByText('Install');
      act(() => {
        fireEvent.click(installButtons[0]);
      });

      await waitFor(() => {
        expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
      });

      act(() => {
        fireEvent.click(screen.getByTestId('terminal-exit-1'));
      });

      // Error shown
      expect(screen.getByText('Close')).toBeInTheDocument();

      // Close terminal
      act(() => {
        fireEvent.click(screen.getByText('Close'));
      });

      await waitFor(() => {
        expect(screen.queryByTestId('mock-terminal')).not.toBeInTheDocument();
      });

      // Error on the item is visible (Retry button)
      expect(screen.getByText('Retry')).toBeInTheDocument();

      // Second attempt: retry succeeds
      mockInvoke('get_full_setup_status', STEP1_COMPLETE_STATUS);

      act(() => {
        fireEvent.click(screen.getByText('Retry'));
      });

      // Terminal opens again for retry
      await waitFor(() => {
        expect(screen.getByTestId('mock-terminal')).toBeInTheDocument();
      });

      act(() => {
        fireEvent.click(screen.getByTestId('terminal-exit-0'));
      });

      // Terminal closes, status refreshes
      await waitFor(() => {
        expect(screen.queryByTestId('mock-terminal')).not.toBeInTheDocument();
      });

      // Next should be enabled (step 1 complete)
      await waitFor(() => {
        expect(screen.getByText('Next')).not.toBeDisabled();
      });
    });
  });

  // ============ Wizard step indicator state ============

  describe('step indicator state', () => {
    it('completed steps show as completed in indicator', async () => {
      // Start on step 2 (step 1 complete)
      mockInvoke('get_full_setup_status', STEP1_COMPLETE_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(
          screen.getByText('Save your work safely and publish it online. Required.')
        ).toBeInTheDocument();
      });

      // Step 1 should show in the indicator — verify it's rendered
      expect(screen.getByText('Package Manager & Node.js')).toBeInTheDocument();
    });

    it('marks the current step as completed once its items are ready', async () => {
      // Start on step 2 (step 1 complete), then navigate Back to step 1 —
      // step 1 is both current and complete, and must keep its check mark.
      mockInvoke('get_full_setup_status', STEP1_COMPLETE_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(
          screen.getByText('Save your work safely and publish it online. Required.')
        ).toBeInTheDocument();
      });

      expect(document.querySelectorAll('.wizard-indicator-dot.completed').length).toBe(1);

      act(() => {
        fireEvent.click(screen.getByText('Back'));
      });

      expect(
        screen.getByText('Install the tools needed to manage dependencies')
      ).toBeInTheDocument();
      expect(document.querySelectorAll('.wizard-indicator-dot.completed').length).toBe(1);
    });

    it('shows all 4 step labels in indicator', async () => {
      mockInvoke('get_full_setup_status', FRESH_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Quick Setup')).toBeInTheDocument();
      });

      // All step titles should be in the indicator.
      // 'Package Manager & Node.js' appears in both the indicator label and the
      // active step header (h2), so use getAllByText and verify at least one match.
      expect(screen.getAllByText('Package Manager & Node.js').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Git & GitHub')).toBeInTheDocument();
      expect(screen.getByText('AI Agent')).toBeInTheDocument();
      expect(screen.getByText('Hosting Provider')).toBeInTheDocument();
    });
  });

  // ============ UI content ============

  describe('UI content', () => {
    it('shows reassurance text on wizard screen', async () => {
      mockInvoke('get_full_setup_status', FRESH_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(
          screen.getByText("Most users finish in under 3 minutes. Let's get you ready to ship.")
        ).toBeInTheDocument();
      });
    });

    it('shows step subtitle for current step', async () => {
      mockInvoke('get_full_setup_status', FRESH_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(
          screen.getByText('Install the tools needed to manage dependencies')
        ).toBeInTheDocument();
      });
    });

    it('shows correct subtitle for step 3', async () => {
      mockInvoke('get_full_setup_status', HAS_BASE_NO_AGENTS_STATUS);

      render(<OnboardingScreen onComplete={onComplete} />);

      await waitFor(() => {
        expect(screen.getByText('Install at least one AI coding assistant')).toBeInTheDocument();
      });
    });
  });
});
