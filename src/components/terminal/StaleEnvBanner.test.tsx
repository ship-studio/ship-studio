/**
 * Tests for StaleEnvBanner — the "your login changed, restart to apply" notice.
 *
 * The behaviour that matters: it appears only when the *matching* workspace's
 * credentials change while a tab is running, and it clears on dismiss.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { sessionRegistry } from '../../lib/sessionRegistry';
import { notifyAccountCredentialsChanged } from '../../lib/accounts';

const getProjectAccountId = vi.fn<(p: string) => Promise<string>>();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string, args?: { projectPath?: string }) => {
    if (cmd === 'get_project_account_id') return getProjectAccountId(args!.projectPath!);
    return Promise.resolve(undefined);
  }),
}));

vi.mock('../icons', () => ({ WarningIcon: () => <span data-testid="warning-icon" /> }));

import { StaleEnvBanner } from './StaleEnvBanner';

const PATH = '/tmp/proj';

function seedRunningTab() {
  sessionRegistry.getOrCreate(PATH);
  sessionRegistry.setTerminalTabs(
    PATH,
    [{ id: 1, agentId: 'claude-code', sessionId: 's1', status: 'running' }],
    0
  );
}

describe('StaleEnvBanner', () => {
  beforeEach(() => {
    sessionRegistry._resetForTests();
    getProjectAccountId.mockReset();
  });
  afterEach(() => {
    sessionRegistry._resetForTests();
  });

  it('does not render when no tabs are stale', () => {
    seedRunningTab();
    render(<StaleEnvBanner projectPath={PATH} />);
    expect(screen.queryByText(/login changed/i)).not.toBeInTheDocument();
  });

  it('appears when the matching workspace credentials change, then clears on dismiss', async () => {
    seedRunningTab();
    getProjectAccountId.mockResolvedValue('circa');
    render(<StaleEnvBanner projectPath={PATH} />);

    await act(async () => {
      notifyAccountCredentialsChanged('circa');
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByText(/login changed/i)).toBeInTheDocument());
    expect(sessionRegistry.hasStaleTabs(PATH)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByText(/login changed/i)).not.toBeInTheDocument());
    expect(sessionRegistry.hasStaleTabs(PATH)).toBe(false);
  });

  it('ignores a credential change for a different workspace', async () => {
    seedRunningTab();
    getProjectAccountId.mockResolvedValue('circa');
    render(<StaleEnvBanner projectPath={PATH} />);

    await act(async () => {
      notifyAccountCredentialsChanged('some-other-workspace');
      await Promise.resolve();
    });

    // Give the async resolver a tick; the banner must stay hidden.
    await Promise.resolve();
    expect(sessionRegistry.hasStaleTabs(PATH)).toBe(false);
    expect(screen.queryByText(/login changed/i)).not.toBeInTheDocument();
  });
});
