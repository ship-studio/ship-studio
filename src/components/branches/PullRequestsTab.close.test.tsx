/**
 * Regression tests for PullRequestsTab's "Close PR" flow (issue #798).
 *
 * `close_pull_request` classifies gh's "already merged" refusal — plus the
 * shared auth / network / no-repo refusals — as `CommandError::Expected`,
 * because the PR list the Close button was clicked from can go stale between
 * fetch and click. `handleClose` nonetheless called `trackError('pr_close', …)`
 * and raised an 'error' toast for every failure, filing those anticipated
 * races as bug reports.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PullRequestsTab } from './PullRequestsTab';
import type { PullRequestInfo } from '../../lib/branches';

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));
vi.mock('../../lib/branches', () => ({
  listPullRequests: vi.fn(),
  mergePullRequest: vi.fn(),
  checkoutPullRequest: vi.fn(),
  closePullRequest: vi.fn(),
  deleteBranch: vi.fn(),
  switchBranch: vi.fn(),
}));
vi.mock('../../lib/analytics', () => ({ trackEvent: vi.fn(), trackError: vi.fn() }));
vi.mock('../../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../contexts/ToastContext', () => ({
  useOptionalToast: () => ({ showToast }),
}));

import { listPullRequests, closePullRequest } from '../../lib/branches';
import { trackError } from '../../lib/analytics';
import { logger } from '../../lib/logger';

type Fn = ReturnType<typeof vi.fn>;

const OPEN_PR: PullRequestInfo = {
  number: 12,
  title: 'Add thing',
  headRef: 'feature/x',
  baseRef: 'main',
  author: 'someone',
  state: 'OPEN',
  mergeable: true,
  isDraft: false,
  url: 'https://github.com/me/repo/pull/12',
  createdAt: '2026-08-23T05:00:00Z',
};

/** Click Close on the PR card, then confirm in the modal. */
async function closeThePr() {
  fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
  const confirm = await screen.findByRole('button', { name: 'Close PR' });
  // The confirm handler's promise chain (close → refetch → dismiss the modal)
  // settles after the click returns; let it flush inside act.
  await act(() => {
    fireEvent.click(confirm);
    return Promise.resolve();
  });
}

function renderTab() {
  render(<PullRequestsTab projectPath="/p" githubUsername="me" onRefresh={vi.fn()} />);
}

describe('PullRequestsTab — closing a pull request (#798)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listPullRequests).mockResolvedValue([OPEN_PR]);
  });

  it("doesn't file a bug report when GitHub already merged the PR", async () => {
    vi.mocked(closePullRequest).mockRejectedValue({
      type: 'Other',
      message:
        "This pull request was already merged, so there's nothing to close. Refresh to see its current state.",
    });

    renderTab();
    await closeThePr();

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.stringContaining('already merged'), 'info');
    });
    expect(trackError as Fn).not.toHaveBeenCalledWith('pr_close', expect.anything(), 'Workspace');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.warn as Fn).toHaveBeenCalled();
    // The on-screen list is stale by definition — refetch it.
    expect(vi.mocked(listPullRequests).mock.calls.length).toBeGreaterThan(1);
  });

  it('still reports a failure it cannot explain', async () => {
    vi.mocked(closePullRequest).mockRejectedValue({
      type: 'Other',
      message: 'Failed to close PR: something exploded',
    });

    renderTab();
    await closeThePr();

    await waitFor(() => {
      expect(trackError as Fn).toHaveBeenCalledWith('pr_close', expect.anything(), 'Workspace');
    });
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('something exploded'), 'error');
  });
});
