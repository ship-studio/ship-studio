/**
 * Tests for AgentsPanel — the dashboard surface for managing coding agents.
 *
 * Covers the main state matrix:
 *   - not installed             → Install button, no pill
 *   - installed / not signed in → Sign in button, kebab with Sign in + Uninstall
 *   - installed / default       → green "Default" pill (disabled), kebab
 *   - installed / not default   → "Set default" pill, clicking → Switching… → Default
 *   - backend error on load     → toast, no rows
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AgentStatus } from '../../lib/agents-management';

// ============ Module-level mocks ============

const invokeResults = new Map<string, { value?: unknown; error?: Error }>();
const invokeCalls: Array<{ cmd: string; args?: unknown }> = [];

function mockInvoke(cmd: string, value: unknown) {
  invokeResults.set(cmd, { value });
}

function mockInvokeErr(cmd: string, error: Error) {
  invokeResults.set(cmd, { error });
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string, args?: unknown) => {
    invokeCalls.push({ cmd, args });
    const result = invokeResults.get(cmd);
    if (result?.error) return Promise.reject(result.error);
    if (result) return Promise.resolve(result.value);
    return Promise.resolve(undefined);
  }),
}));

// Avoid pulling xterm / tauri-pty into the test environment.
vi.mock('../setup/OnboardingTerminal', () => ({
  OnboardingTerminal: ({ onExit }: { onExit: (c: number | null) => void }) => (
    <div data-testid="mock-terminal">
      <button data-testid="terminal-exit-0" onClick={() => onExit(0)}>
        Exit 0
      </button>
    </div>
  ),
}));

// Backend-owned connect terminal — stub it so tests can drive the
// captured/exit signals without an xterm + live PTY.
vi.mock('./ClaudeConnectTerminal', () => ({
  ClaudeConnectTerminal: ({
    onCaptured,
    onExit,
  }: {
    onCaptured: () => void;
    onExit: (c: number) => void;
  }) => (
    <div data-testid="mock-connect-terminal">
      <button data-testid="connect-captured" onClick={() => onCaptured()}>
        captured
      </button>
      <button data-testid="connect-exit" onClick={() => onExit(0)}>
        exit
      </button>
    </div>
  ),
}));

// Generic per-workspace connect terminal (GitHub/Codex/Opencode) — stub it so
// tests can drive the exit signal without an xterm + live PTY.
vi.mock('./WorkspaceConnectTerminal', () => ({
  WorkspaceConnectTerminal: ({ onExit }: { onExit: (c: number) => void }) => (
    <div data-testid="mock-workspace-connect-terminal">
      <button data-testid="workspace-connect-exit-0" onClick={() => onExit(0)}>
        exit 0
      </button>
    </div>
  ),
}));

// Strip heavy icon SVGs; only need predictable DOM.
vi.mock('../icons', () => ({
  CheckIcon: () => <span data-testid="check-icon" />,
  ClaudeIcon: () => <span data-testid="claude-icon" />,
  CodexIcon: () => <span data-testid="codex-icon" />,
  OpencodeIcon: () => <span data-testid="opencode-icon" />,
  CursorIcon: () => <span data-testid="cursor-icon" />,
  GitHubIcon: () => <span data-testid="github-icon" />,
  VercelIcon: () => <span data-testid="vercel-icon" />,
}));

import { AgentsPanel } from './AgentsPanel';

// ============ Fixture helpers ============

function agent(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    binaryName: 'claude',
    installed: true,
    version: '1.2.3',
    authed: true,
    authEmail: null,
    needsReconnect: false,
    isDefault: false,
    installSupported: true,
    uninstallSupported: true,
    ...overrides,
  };
}

const CLAUDE_DEFAULT = agent({ isDefault: true });
const CODEX_READY = agent({
  id: 'codex',
  displayName: 'Codex',
  binaryName: 'codex',
  version: '0.1.0',
  isDefault: false,
});
const OPENCODE_NOT_INSTALLED = agent({
  id: 'opencode',
  displayName: 'Opencode',
  binaryName: 'opencode',
  installed: false,
  version: null,
  authed: false,
  isDefault: false,
});
const CODEX_UNAUTHED = agent({
  id: 'codex',
  displayName: 'Codex',
  binaryName: 'codex',
  version: '0.1.0',
  authed: false,
  isDefault: false,
});

// ============ Tests ============

describe('AgentsPanel', () => {
  beforeEach(() => {
    invokeResults.clear();
    invokeCalls.length = 0;
  });

  it('renders one row per agent returned by the backend', async () => {
    mockInvoke('get_agents_status', [CLAUDE_DEFAULT, CODEX_READY, OPENCODE_NOT_INSTALLED]);
    render(<AgentsPanel />);

    await waitFor(() => {
      expect(screen.getByText('Claude Code')).toBeInTheDocument();
    });
    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByText('Opencode')).toBeInTheDocument();
  });

  it('shows "Install" button for a not-installed agent', async () => {
    mockInvoke('get_agents_status', [OPENCODE_NOT_INSTALLED]);
    render(<AgentsPanel />);

    await waitFor(() => expect(screen.getByText('Opencode')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Install' })).toBeInTheDocument();
    expect(screen.getByText('Not installed')).toBeInTheDocument();
    // No "Set default" pill for an uninstalled agent.
    expect(screen.queryByText('Set default')).not.toBeInTheDocument();
  });

  it('shows "Sign in" button and "Not signed in" status when installed but unauthed', async () => {
    mockInvoke('get_agents_status', [CODEX_UNAUTHED]);
    render(<AgentsPanel />);

    await waitFor(() => expect(screen.getByText('Codex')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText('Not signed in')).toBeInTheDocument();
    expect(screen.queryByText('Set default')).not.toBeInTheDocument();
  });

  it('renders "Default" pill (disabled) for the current default agent', async () => {
    mockInvoke('get_agents_status', [CLAUDE_DEFAULT, CODEX_READY]);
    render(<AgentsPanel />);

    // The workspace badge can also read "Default", so target the pill by role
    // (the badge is a span). "Set default" has a lowercase d, so /Default/ only
    // matches the active "Default" pill.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Default/ })).toBeInTheDocument()
    );
    const defaultPill = screen.getByRole('button', { name: /Default/ });
    expect(defaultPill).toBeDisabled();
  });

  it('renders "Set default" pill for ready non-default agents', async () => {
    mockInvoke('get_agents_status', [CLAUDE_DEFAULT, CODEX_READY]);
    render(<AgentsPanel />);

    await waitFor(() => expect(screen.getByText('Set default')).toBeInTheDocument());
    const setDefaultPill = screen.getByRole('button', { name: /Set default/ });
    expect(setDefaultPill).not.toBeDisabled();
  });

  it('set-default flow shows Switching… state then settles on the new default', async () => {
    mockInvoke('get_agents_status', [CLAUDE_DEFAULT, CODEX_READY]);

    // Hold the backend write until we release it, so we can observe the
    // intermediate Switching… state deterministically.
    let releaseBackend!: () => void;
    const backendGate = new Promise<void>((resolve) => {
      releaseBackend = resolve;
    });
    invokeResults.set('set_default_agent_id', {
      value: backendGate.then(() => undefined),
    });

    render(<AgentsPanel />);
    await waitFor(() => expect(screen.getByText('Set default')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Set default/ }));

    // Mid-flight: Switching… is visible, "Set default" has been replaced.
    await waitFor(() => expect(screen.getByText('Switching…')).toBeInTheDocument());
    expect(screen.queryByText('Set default')).not.toBeInTheDocument();

    // Release the backend and expect the new default to settle on Codex.
    releaseBackend();
    await waitFor(() => expect(screen.queryByText('Switching…')).not.toBeInTheDocument());

    // Codex row should now own the Default pill; Claude Code should show "Set default".
    // (Query the pill by role — the workspace badge also reads "Default".)
    expect(screen.getByRole('button', { name: /Default/ })).toBeInTheDocument();
    expect(screen.getByText('Set default')).toBeInTheDocument();

    // Confirm the backend was actually called with the right agent id.
    const setDefaultCall = invokeCalls.find((c) => c.cmd === 'set_default_agent_id');
    expect(setDefaultCall?.args).toMatchObject({ agentId: 'codex' });
  });

  it('kebab menu surfaces Update / Sign out / Uninstall for a ready agent', async () => {
    mockInvoke('get_agents_status', [CLAUDE_DEFAULT]);
    render(<AgentsPanel />);

    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());

    const kebab = screen.getByRole('button', { name: /More actions for Claude Code/ });
    fireEvent.click(kebab);

    expect(screen.getByRole('menuitem', { name: 'Update' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Uninstall' })).toBeInTheDocument();
  });

  it('kebab menu offers Sign in (not Sign out) when the agent is unauthed', async () => {
    mockInvoke('get_agents_status', [CODEX_UNAUTHED]);
    render(<AgentsPanel />);

    await waitFor(() => expect(screen.getByText('Codex')).toBeInTheDocument());

    const kebab = screen.getByRole('button', { name: /More actions for Codex/ });
    fireEvent.click(kebab);

    expect(screen.getByRole('menuitem', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Sign out' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Uninstall' })).toBeInTheDocument();
  });

  it('sign-out invokes sign_out_agent with the correct id', async () => {
    mockInvoke('get_agents_status', [CLAUDE_DEFAULT]);
    mockInvoke('sign_out_agent', undefined);

    render(<AgentsPanel />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /More actions for Claude Code/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    await waitFor(() => {
      const call = invokeCalls.find((c) => c.cmd === 'sign_out_agent');
      expect(call).toBeDefined();
      expect(call?.args).toMatchObject({ agentId: 'claude-code' });
    });
  });

  it('uninstall opens a confirmation modal before invoking the backend', async () => {
    mockInvoke('get_agents_status', [CODEX_READY]);
    mockInvoke('uninstall_agent', 'Uninstalled.');

    render(<AgentsPanel />);
    await waitFor(() => expect(screen.getByText('Codex')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /More actions for Codex/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Uninstall' }));

    // Confirmation shown, backend not yet invoked.
    expect(screen.getByText('Uninstall Codex?')).toBeInTheDocument();
    expect(invokeCalls.find((c) => c.cmd === 'uninstall_agent')).toBeUndefined();

    // Confirm via the modal's Uninstall button.
    const confirmBtn = screen
      .getAllByRole('button', { name: 'Uninstall' })
      .find((b) => b.className.includes('button--danger'));
    expect(confirmBtn).toBeDefined();
    fireEvent.click(confirmBtn!);

    await waitFor(() => {
      const call = invokeCalls.find((c) => c.cmd === 'uninstall_agent');
      expect(call).toBeDefined();
      expect(call?.args).toMatchObject({ agentId: 'codex' });
    });
  });

  it('swallows a backend error on load without crashing', async () => {
    mockInvokeErr('get_agents_status', new Error('boom'));
    render(<AgentsPanel />);

    // Load resolves (via catch) and the header still renders; no rows.
    await waitFor(() =>
      expect(screen.getByText(/each workspace signs in separately/)).toBeInTheDocument()
    );
    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();
  });

  // ============ Per-workspace Claude auth (email + reconnect) ============

  it('shows the account email instead of a generic "Signed in"', async () => {
    mockInvoke('get_agents_status', [
      agent({ isDefault: true, authEmail: 'circa@circabranding.com' }),
    ]);
    render(<AgentsPanel />);

    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());
    expect(screen.getByText('v1.2.3 · circa@circabranding.com')).toBeInTheDocument();
  });

  it('renders a red Reconnect button + status when the token needs reconnect', async () => {
    mockInvoke('get_agents_status', [
      agent({ authed: true, needsReconnect: true, authEmail: 'circa@circabranding.com' }),
    ]);
    const { container } = render(<AgentsPanel />);

    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(screen.getByText('circa@circabranding.com · Reconnect needed')).toBeInTheDocument();
    // The card carries the red stroke class, not the green connected one.
    expect(container.querySelector('.agents-panel-row.needs-reconnect')).toBeInTheDocument();
    expect(container.querySelector('.agents-panel-row.is-connected')).not.toBeInTheDocument();
    // No "Set default" pill while a reconnect is pending.
    expect(screen.queryByText('Set default')).not.toBeInTheDocument();
  });

  it('keeps the neutral never-connected UI (no red, plain "Sign in")', async () => {
    mockInvoke('get_agents_status', [agent({ authed: false, needsReconnect: false })]);
    const { container } = render(<AgentsPanel />);

    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());
    expect(screen.getByText('Not signed in')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(container.querySelector('.needs-reconnect')).not.toBeInTheDocument();
    expect(container.querySelector('.is-connected')).not.toBeInTheDocument();
  });

  it('routes Claude "Sign in" to the connect modal in a non-default workspace', async () => {
    mockInvoke('get_agents_status', [agent({ authed: false })]);
    mockInvoke('get_active_account_id', 'circa');
    mockInvoke('list_accounts', [
      { id: 'circa', name: 'Circa', color: '#000', isDefault: false, createdAt: 0 },
    ]);
    render(<AgentsPanel />);

    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());
    // Wait for the active workspace to resolve, then click Sign in.
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === 'list_accounts')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    // The connect modal opens at its email phase (no OnboardingTerminal),
    // naming the workspace.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
    );
    // The workspace name appears in both the header badge and the modal copy.
    expect(screen.getAllByText(/Circa/).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('mock-terminal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mock-connect-terminal')).not.toBeInTheDocument();
  });

  it('connect flow: Continue opens the PTY terminal; capture closes + refreshes', async () => {
    mockInvoke('get_agents_status', [agent({ authed: false })]);
    mockInvoke('get_active_account_id', 'circa');
    mockInvoke('list_accounts', [
      { id: 'circa', name: 'Circa', color: '#000', isDefault: false, createdAt: 0 },
    ]);
    render(<AgentsPanel />);

    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === 'list_accounts')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    // Email phase → Continue advances to the backend-PTY terminal phase.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByTestId('mock-connect-terminal')).toBeInTheDocument());

    // Rust signals the token was captured → modal closes and status refreshes.
    const refreshesBefore = invokeCalls.filter((c) => c.cmd === 'get_agents_status').length;
    fireEvent.click(screen.getByTestId('connect-captured'));
    await waitFor(() =>
      expect(screen.queryByTestId('mock-connect-terminal')).not.toBeInTheDocument()
    );
    expect(invokeCalls.filter((c) => c.cmd === 'get_agents_status').length).toBeGreaterThan(
      refreshesBefore
    );
  });

  it('Default workspace Claude "Sign in" still uses the terminal flow', async () => {
    mockInvoke('get_agents_status', [agent({ authed: false })]);
    mockInvoke('get_active_account_id', 'default');
    mockInvoke('list_accounts', [
      { id: 'default', name: 'Default', color: '#000', isDefault: true, createdAt: 0 },
    ]);
    render(<AgentsPanel />);

    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === 'list_accounts')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    // Terminal modal opens; no connect modal.
    await waitFor(() => expect(screen.getByTestId('mock-terminal')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('mock-connect-terminal')).not.toBeInTheDocument();
  });

  // ============ Workspace badge + section grouping + Services rows ============

  const CIRCA = { id: 'circa', name: 'Circa', color: '#abcdef', isDefault: false, createdAt: 0 };
  const DEFAULT_WS = {
    id: 'default',
    name: 'Default',
    color: '#000',
    isDefault: true,
    createdAt: 0,
  };

  function mockWorkspace(account: typeof CIRCA | typeof DEFAULT_WS) {
    mockInvoke('get_active_account_id', account.id);
    mockInvoke('list_accounts', [account]);
  }

  it('names the active workspace and groups rows under Coding agents / Services', async () => {
    mockInvoke('get_agents_status', [CLAUDE_DEFAULT]);
    mockWorkspace(CIRCA);
    render(<AgentsPanel />);

    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === 'list_accounts')).toBe(true));
    // Workspace badge names the active workspace.
    await waitFor(() => expect(screen.getAllByText(/Circa/).length).toBeGreaterThan(0));
    // The two section subheaders are present.
    expect(screen.getByText('Coding agents')).toBeInTheDocument();
    expect(screen.getByText('Services')).toBeInTheDocument();
    // The Services rows render for GitHub + Vercel.
    expect(screen.getByText('GitHub')).toBeInTheDocument();
    expect(screen.getByText('Vercel')).toBeInTheDocument();
  });

  it('shows the workspace Vercel identity once the credential status resolves', async () => {
    mockInvoke('get_agents_status', [CLAUDE_DEFAULT]);
    mockWorkspace(CIRCA);
    mockInvoke('get_account_credential_status', {
      githubAuthEmail: 'octocat@github.com',
      vercelUsername: 'circa-team',
    });
    render(<AgentsPanel />);

    await waitFor(() => expect(screen.getByText('circa-team')).toBeInTheDocument());
    expect(screen.getByText('octocat@github.com')).toBeInTheDocument();
    // Connected services show a kebab, not a Connect button.
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
  });

  it('non-default workspace: Vercel "Connect" opens the token modal and saves the credential', async () => {
    mockInvoke('get_agents_status', [CLAUDE_DEFAULT]);
    mockWorkspace(CIRCA);
    // No credential status → both services read "Connect".
    render(<AgentsPanel />);

    await waitFor(() => expect(screen.getByText('Vercel')).toBeInTheDocument());
    // Both GitHub + Vercel offer Connect; grab them in row order.
    const connectButtons = screen.getAllByRole('button', { name: 'Connect' });
    expect(connectButtons).toHaveLength(2);
    fireEvent.click(connectButtons[1]); // Vercel row

    // Token modal opens (no native terminal).
    const input = await screen.findByPlaceholderText('vercel_xxxxxxxxxxxxxxxx');
    expect(screen.queryByTestId('mock-terminal')).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: '  vercel_abc123  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const call = invokeCalls.find((c) => c.cmd === 'set_account_credential');
      expect(call?.args).toMatchObject({
        id: 'circa',
        key: 'vercel_token',
        value: 'vercel_abc123',
      });
    });
  });

  it('non-default workspace: GitHub "Connect" routes through the backend PTY modal', async () => {
    mockInvoke('get_agents_status', [CLAUDE_DEFAULT]);
    mockWorkspace(CIRCA);
    render(<AgentsPanel />);

    await waitFor(() => expect(screen.getByText('GitHub')).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('button', { name: 'Connect' })[0]); // GitHub row

    // The generic workspace-connect terminal mounts (config-dir PTY login),
    // not the native machine terminal.
    await waitFor(() =>
      expect(screen.getByTestId('mock-workspace-connect-terminal')).toBeInTheDocument()
    );
    expect(screen.queryByTestId('mock-terminal')).not.toBeInTheDocument();
  });

  it('Default workspace: GitHub + Vercel "Connect" use the native machine terminal', async () => {
    mockInvoke('get_agents_status', [CLAUDE_DEFAULT]);
    mockWorkspace(DEFAULT_WS);
    render(<AgentsPanel />);

    await waitFor(() => expect(screen.getByText('GitHub')).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('button', { name: 'Connect' })[0]); // GitHub row

    // Default uses the machine's native logins — the native OnboardingTerminal,
    // never the workspace-isolated PTY or the Vercel token modal.
    await waitFor(() => expect(screen.getByTestId('mock-terminal')).toBeInTheDocument());
    expect(screen.queryByTestId('mock-workspace-connect-terminal')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('vercel_xxxxxxxxxxxxxxxx')).not.toBeInTheDocument();
  });
});
