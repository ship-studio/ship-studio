/**
 * Regression tests for the create-branch conflict modal's post-stash switch
 * (#564). The modal exists to clear uncommitted changes, but stragglers can
 * reappear between the stash/commit step and the switch (dev-server config
 * writes, polling races) — the switch then failed with the raw "Uncommitted
 * changes" string and the flow dead-ended. It must retry once with auto-stash
 * (mirroring UnsavedChangesModal's #273/PR #281 fix) and, if that still
 * fails, hand the user a path forward instead of a raw terminal failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { CreateBranchConflictModal } from './CreateBranchConflictModal';
import { ToastContext } from '../../contexts/ToastContext';

vi.mock('../../lib/branches', () => ({
  createBranch: vi.fn(),
  switchBranch: vi.fn(),
}));
vi.mock('../../lib/git', () => ({
  commitChanges: vi.fn(),
  stashChanges: vi.fn(),
}));
vi.mock('../../lib/ai', () => ({ generateCommitMessage: vi.fn() }));

import { createBranch, switchBranch } from '../../lib/branches';
import { stashChanges } from '../../lib/git';

const okSwitch = {
  success: true,
  stashedChanges: false,
  pendingStashFrom: null,
  stashApplied: false,
  error: null,
};

const uncommittedFailure = {
  ...okSwitch,
  success: false,
  error: 'Uncommitted changes. Please stash or commit them first.',
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

describe('CreateBranchConflictModal — post-stash switch retry (#564)', () => {
  const props = {
    projectPath: '/test/project',
    currentBranch: 'main',
    targetBranch: 'feat/new',
    baseBranch: 'main',
    onCreated: vi.fn(),
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(stashChanges).mockResolvedValue(true);
    vi.mocked(createBranch).mockResolvedValue(undefined);
  });

  it('retries the switch with auto-stash when stragglers reappear, then succeeds', async () => {
    vi.mocked(switchBranch)
      .mockResolvedValueOnce(uncommittedFailure) // plain switch trips on stragglers
      .mockResolvedValueOnce(okSwitch); // auto-stash retry wins

    const { showToast } = renderWithToasts(<CreateBranchConflictModal {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /stash & create/i }));

    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    expect(switchBranch).toHaveBeenNthCalledWith(1, '/test/project', 'feat/new', false);
    expect(switchBranch).toHaveBeenNthCalledWith(2, '/test/project', 'feat/new', true);
    expect(props.onCreated).toHaveBeenCalledWith('feat/new');
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('Created and switched to feat/new'),
      'success'
    );
  });

  it('gives a path forward (not a raw dead-end) when even the retry fails', async () => {
    vi.mocked(switchBranch).mockResolvedValue(uncommittedFailure);

    const { showToast } = renderWithToasts(<CreateBranchConflictModal {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /stash & create/i }));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    // Retried once with auto-stash before giving up.
    expect(switchBranch).toHaveBeenCalledTimes(2);
    const [message, type] = showToast.mock.calls[0];
    expect(type).toBe('error');
    expect(message).toContain('Created "feat/new"');
    expect(message).toContain('Branches tab');
    // The modal closes rather than dead-ending (its actions would only trip
    // over the now-existing branch), and the switched callback never fires.
    expect(props.onClose).toHaveBeenCalled();
    expect(props.onCreated).not.toHaveBeenCalled();
  });

  it('does not retry when the switch fails for an unrelated reason', async () => {
    vi.mocked(switchBranch).mockResolvedValue({
      ...okSwitch,
      success: false,
      error: "fatal: 'feat/new' is already used by worktree at '/x/.claude/worktrees/feat-new'",
    });

    const { showToast } = renderWithToasts(<CreateBranchConflictModal {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /stash & create/i }));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(switchBranch).toHaveBeenCalledTimes(1);
    const [message] = showToast.mock.calls[0];
    // The raw fatal is humanized on the way out.
    expect(message).toContain('already checked out in another worktree');
    expect(message).not.toContain('fatal:');
  });
});
