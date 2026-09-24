/**
 * A switch the header's Branches menu hands over (issue #1012) goes through
 * the Branches view's own switch flow — whether it was queued before the view
 * mounted or while it was already open — and only once.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { BranchesTab } from './BranchesTab';
import type { BranchInfo } from '../../lib/branches';

vi.mock('../../lib/branches', () => ({
  switchBranch: vi.fn(),
  deleteBranch: vi.fn(),
  createBranch: vi.fn(),
  discardChanges: vi.fn(),
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
vi.mock('./BranchGraph', () => ({ BranchGraph: () => null }));
vi.mock('./UnsavedChangesModal', () => ({ UnsavedChangesModal: () => null }));
vi.mock('./MergeConflictModal', () => ({ MergeConflictModal: () => null }));
vi.mock('./CreateBranchConflictModal', () => ({ CreateBranchConflictModal: () => null }));

import {
  formatRelativeTime,
  getBranchPrefixPreference,
  getDefaultBaseBranch,
  sanitizeBranchName,
  switchBranch,
} from '../../lib/branches';
import { getConflictInfo } from '../../lib/conflicts';
import { queueBranchSwitch } from '../../lib/branchSwitchHandoff';

const branch = (name: string, isCurrent: boolean): BranchInfo => ({
  name,
  isCurrent,
  isRemote: false,
  isDefault: name === 'main',
  lastCommitDate: Date.now(),
  lastCommitAuthor: 'Test',
  aheadOfMain: 0,
  behindOfMain: 0,
  pushed: true,
});

const props = {
  branches: [branch('main', true), branch('feature', false)],
  currentBranch: 'main',
  projectPath: '/test/project',
  githubUsername: null,
  openPRs: [],
  onBranchSwitch: vi.fn(),
  onSubmitForReview: vi.fn(),
  onRefresh: vi.fn(),
};

describe('BranchesTab — switch handed over from the Branches menu (#1012)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBranchPrefixPreference).mockResolvedValue(true);
    vi.mocked(getDefaultBaseBranch).mockResolvedValue(null);
    vi.mocked(formatRelativeTime).mockReturnValue('just now');
    vi.mocked(sanitizeBranchName).mockImplementation((s: string) => s);
    vi.mocked(getConflictInfo).mockResolvedValue([]);
    vi.mocked(switchBranch).mockResolvedValue({
      success: true,
      stashedChanges: false,
      pendingStashFrom: null,
      stashApplied: false,
      error: null,
    });
  });

  it('runs a switch queued before the view mounted, once', async () => {
    queueBranchSwitch('/test/project', 'feature');
    const { unmount } = render(<BranchesTab {...props} />);
    await waitFor(() => expect(props.onBranchSwitch).toHaveBeenCalledWith('feature'));
    expect(switchBranch).toHaveBeenCalledWith('/test/project', 'feature', false);

    unmount();
    render(<BranchesTab {...props} />);
    await act(async () => {});
    expect(switchBranch).toHaveBeenCalledTimes(1);
  });

  it('runs a switch queued while the view is open', async () => {
    render(<BranchesTab {...props} />);
    act(() => queueBranchSwitch('/test/project', 'feature'));
    await waitFor(() => expect(props.onBranchSwitch).toHaveBeenCalledWith('feature'));
  });

  it('ignores a switch queued for another project', async () => {
    queueBranchSwitch('/other/project', 'feature');
    render(<BranchesTab {...props} />);
    await act(async () => {});
    expect(switchBranch).not.toHaveBeenCalled();
  });
});
