/**
 * Regression tests for "Revert to GitHub" on a branch with no upstream (#539).
 *
 * `git pull` on a never-pushed branch fails with git's "There is no tracking
 * information for the current branch" refusal — an expected user state, not an
 * app malfunction (the backend classifies it Expected). The handler used to
 * toast the raw git dump as an 'error' (which self-reports to telemetry); it
 * must instead explain the situation as an info toast + warn log, and humanize
 * any other failure instead of leaking raw stderr.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { BranchesTab } from './BranchesTab';
import { ToastContext } from '../../contexts/ToastContext';
import type { BranchInfo } from '../../lib/branches';

vi.mock('../../lib/branches', () => ({
  switchBranch: vi.fn(),
  deleteBranch: vi.fn(),
  createBranch: vi.fn(),
  discardChanges: vi.fn().mockResolvedValue(undefined),
  formatRelativeTime: vi.fn(() => 'just now'),
  getBranchPrefixPreference: vi.fn().mockResolvedValue(true),
  setBranchPrefixPreference: vi.fn().mockResolvedValue(undefined),
  getDefaultBaseBranch: vi.fn().mockResolvedValue(null),
  pushBranch: vi.fn(),
  sanitizeBranchName: vi.fn((s: string) => s),
}));
vi.mock('../../lib/git', () => ({ gitPull: vi.fn() }));
vi.mock('../../lib/worktrees', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  removeWorktree: vi.fn(),
  pruneWorktrees: vi.fn(),
}));
vi.mock('../../lib/project', () => ({ openProjectInNewWindow: vi.fn() }));
vi.mock('../../lib/conflicts', () => ({ getConflictInfo: vi.fn() }));
vi.mock('../../lib/analytics', () => ({ trackEvent: vi.fn(), trackError: vi.fn() }));
vi.mock('../../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('./BranchGraph', () => ({ BranchGraph: () => null }));
vi.mock('./UnsavedChangesModal', () => ({ UnsavedChangesModal: () => null }));
vi.mock('./MergeConflictModal', () => ({ MergeConflictModal: () => null }));
vi.mock('./CreateBranchConflictModal', () => ({ CreateBranchConflictModal: () => null }));

import {
  discardChanges,
  formatRelativeTime,
  getBranchPrefixPreference,
  getDefaultBaseBranch,
  sanitizeBranchName,
} from '../../lib/branches';
import { listWorktrees } from '../../lib/worktrees';
import { gitPull } from '../../lib/git';
import { logger } from '../../lib/logger';

type Fn = ReturnType<typeof vi.fn>;

const currentBranch: BranchInfo = {
  name: 'feat/unpushed',
  isCurrent: true,
  isRemote: false,
  isDefault: false,
  lastCommitDate: Date.now(),
  lastCommitAuthor: 'Test',
  aheadOfMain: 1,
  behindOfMain: 0,
  pushed: false,
};

function renderWithToasts(ui: ReactNode) {
  const showToast = vi.fn<(message: string, type?: 'success' | 'error' | 'info') => void>();
  render(
    <ToastContext.Provider value={{ toasts: [], showToast, dismissToast: vi.fn() }}>
      {ui}
    </ToastContext.Provider>
  );
  return { showToast };
}

async function clickThroughRevert() {
  fireEvent.click(screen.getByRole('button', { name: /revert to github/i }));
  // Confirm modal
  fireEvent.click(await screen.findByRole('button', { name: /^revert$/i }));
}

describe('BranchesTab — Revert to GitHub with no upstream (#539)', () => {
  const props = {
    branches: [currentBranch],
    currentBranch: 'feat/unpushed',
    projectPath: '/test/project',
    githubUsername: null,
    openPRs: [],
    onBranchSwitch: vi.fn(),
    onSubmitForReview: vi.fn(),
    onRefresh: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-seed implementations — clearing wipes the factory-time defaults.
    vi.mocked(discardChanges).mockResolvedValue(undefined);
    vi.mocked(getBranchPrefixPreference).mockResolvedValue(true);
    vi.mocked(getDefaultBaseBranch).mockResolvedValue(null);
    vi.mocked(formatRelativeTime).mockReturnValue('just now');
    vi.mocked(sanitizeBranchName).mockImplementation((s: string) => s);
    vi.mocked(listWorktrees).mockResolvedValue([]);
  });

  it('explains the missing upstream as an info toast + warn log, not a raw git error', async () => {
    vi.mocked(gitPull).mockRejectedValue({
      type: 'Other',
      message:
        'Failed to pull: There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.\nSee git-pull(1) for details.',
    });

    const { showToast } = renderWithToasts(<BranchesTab {...props} />);
    await clickThroughRevert();

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    const [message, type] = showToast.mock.calls[0];
    expect(type).toBe('info');
    expect(message).toContain('never been pushed');
    expect(message).toContain('feat/unpushed');
    // Honest about the discard that already happened.
    expect(message).toContain('discarded');
    // The raw git dump stays out of the toast.
    expect(message).not.toContain('git-pull(1)');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.warn as Fn).toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.error as Fn).not.toHaveBeenCalled();
    expect(props.onRefresh).toHaveBeenCalled();
  });

  it('humanizes other pull failures instead of leaking raw stderr', async () => {
    vi.mocked(gitPull).mockRejectedValue({
      type: 'Other',
      message: 'fatal: unable to access https://github.com/a/b: Could not resolve host: github.com',
    });

    const { showToast } = renderWithToasts(<BranchesTab {...props} />);
    await clickThroughRevert();

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    const [message, type] = showToast.mock.calls[0];
    expect(type).toBe('error');
    expect(message).toContain('Failed to revert:');
    expect(message).toMatch(/couldn't reach GitHub/i);
    expect(message).not.toContain('fatal:');
  });
});
