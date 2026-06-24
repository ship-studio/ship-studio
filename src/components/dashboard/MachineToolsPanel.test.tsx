/**
 * Tests for MachineToolsPanel — the machine-tier half of the dashboard
 * integration split.
 *
 * The one behaviour that matters here and can't be eyeballed: this card lists
 * ONLY machine-tier tools (Homebrew, Node, Git, CLI binaries) and never the
 * per-workspace `*_auth` logins, which belong to AgentsPanel ("Workspace
 * accounts"). It's also purely informational — no Connect/Install actions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { SetupItem } from '../../lib/setup';

const invokeResults = new Map<string, { value?: unknown; error?: Error }>();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string) => {
    const result = invokeResults.get(cmd);
    if (result?.error) return Promise.reject(result.error);
    if (result) return Promise.resolve(result.value);
    return Promise.resolve(undefined);
  }),
}));

vi.mock('../icons', () => ({
  CheckIcon: () => <span data-testid="check-icon" />,
  WarningIcon: () => <span data-testid="warning-icon" />,
  ChevronIcon: () => <span data-testid="chevron-icon" />,
  ClaudeIcon: () => <span data-testid="claude-icon" />,
  GitHubIcon: () => <span data-testid="github-icon" />,
}));

import { MachineToolsPanel } from './MachineToolsPanel';

function item(overrides: Partial<SetupItem> & { id: string; friendlyName: string }): SetupItem {
  return { status: 'ready', version: '1.0.0', ...overrides };
}

function mockSetupStatus(items: SetupItem[]) {
  invokeResults.set('get_full_setup_status', {
    value: {
      allReady: false,
      items,
      optionalAuths: { githubAuthenticated: false },
      detectedAgents: [],
    },
  });
}

describe('MachineToolsPanel', () => {
  beforeEach(() => {
    invokeResults.clear();
  });

  it('renders the machine-tools card title', async () => {
    mockSetupStatus([item({ id: 'homebrew', friendlyName: 'Homebrew' })]);
    render(<MachineToolsPanel />);
    await waitFor(() => expect(screen.getByText('Tools on this Mac')).toBeInTheDocument());
  });

  it('lists only machine-tier tools and never the per-workspace logins', async () => {
    mockSetupStatus([
      item({ id: 'homebrew', friendlyName: 'Homebrew' }),
      item({ id: 'git', friendlyName: 'Git' }),
      item({ id: 'gh', friendlyName: 'GitHub CLI' }),
      // Workspace-tier logins — must be filtered out of this card.
      item({ id: 'gh_auth', friendlyName: 'GitHub account' }),
      item({ id: 'claude_auth', friendlyName: 'Claude account' }),
      item({ id: 'vercel_auth', friendlyName: 'Vercel account' }),
    ]);
    render(<MachineToolsPanel />);

    // Collapsed by default — expand to reveal the rows.
    await waitFor(() => expect(screen.getByText('Tools on this Mac')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    await waitFor(() => expect(screen.getByText('Homebrew')).toBeInTheDocument());
    expect(screen.getByText('Git')).toBeInTheDocument();
    expect(screen.getByText('GitHub CLI')).toBeInTheDocument();

    // None of the workspace-login rows leak into the machine card.
    expect(screen.queryByText('GitHub account')).not.toBeInTheDocument();
    expect(screen.queryByText('Claude account')).not.toBeInTheDocument();
    expect(screen.queryByText('Vercel account')).not.toBeInTheDocument();
  });

  it('shows the version when ready and "Not installed" otherwise', async () => {
    mockSetupStatus([
      item({ id: 'homebrew', friendlyName: 'Homebrew', status: 'ready', version: '4.2.1' }),
      item({ id: 'node', friendlyName: 'Node.js', status: 'not_installed', version: undefined }),
    ]);
    render(<MachineToolsPanel />);

    await waitFor(() => expect(screen.getByText('Tools on this Mac')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    await waitFor(() => expect(screen.getByText('4.2.1')).toBeInTheDocument());
    expect(screen.getByText('Not installed')).toBeInTheDocument();
  });

  it('is purely informational — no Connect or Install buttons', async () => {
    mockSetupStatus([
      item({ id: 'node', friendlyName: 'Node.js', status: 'not_installed', version: undefined }),
    ]);
    render(<MachineToolsPanel />);

    await waitFor(() => expect(screen.getByText('Tools on this Mac')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    await waitFor(() => expect(screen.getByText('Node.js')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Connect/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Install/ })).not.toBeInTheDocument();
  });

  it('swallows a backend error without crashing', async () => {
    invokeResults.set('get_full_setup_status', { error: new Error('boom') });
    render(<MachineToolsPanel />);
    // Header still renders; no rows.
    await waitFor(() => expect(screen.getByText('Tools on this Mac')).toBeInTheDocument());
  });
});
