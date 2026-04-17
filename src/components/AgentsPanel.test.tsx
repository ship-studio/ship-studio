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
import type { AgentStatus } from '../lib/agents-management';

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
vi.mock('./setup/OnboardingTerminal', () => ({
  OnboardingTerminal: ({ onExit }: { onExit: (c: number | null) => void }) => (
    <div data-testid="mock-terminal">
      <button data-testid="terminal-exit-0" onClick={() => onExit(0)}>
        Exit 0
      </button>
    </div>
  ),
}));

// Strip heavy icon SVGs; only need predictable DOM.
vi.mock('./icons', () => ({
  CheckIcon: () => <span data-testid="check-icon" />,
  SpinnerIcon: () => <span data-testid="spinner-icon" />,
  ClaudeIcon: () => <span data-testid="claude-icon" />,
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

    await waitFor(() => expect(screen.getByText('Default')).toBeInTheDocument());
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
    expect(screen.getByText('Default')).toBeInTheDocument();
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
      expect(screen.getByText(/Install, sign in, or switch/)).toBeInTheDocument()
    );
    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();
  });
});
