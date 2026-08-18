/**
 * Regression tests for UnsavedChangesModal error handling (issue #726).
 *
 * Recognized git failures (e.g. non-fast-forward push rejections) should be humanized
 * and toasted with 'info' rather than 'error' to prevent false error reporting to telemetry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { UnsavedChangesModal } from './UnsavedChangesModal';
import { ToastContext } from '../../contexts/ToastContext';

vi.mock('../../lib/branches', () => ({
  publishBranch: vi.fn(),
  discardChanges: vi.fn(),
  switchBranch: vi.fn(),
}));

import { publishBranch, discardChanges, switchBranch } from '../../lib/branches';

const okSwitch = {
  success: true,
  stashedChanges: false,
  pendingStashFrom: null,
  stashApplied: false,
  error: null,
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

describe('UnsavedChangesModal — recognized git failure handling (#726)', () => {
  const props = {
    projectPath: '/test/project',
    currentBranch: 'feat/my-branch',
    targetBranch: 'main',
    onSwitchComplete: vi.fn(),
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(switchBranch).mockResolvedValue(okSwitch);
  });

  it('routes recognized push failure (non-fast-forward) to info toast with humanized message', async () => {
    const pushRejectedError =
      'PUSH_REJECTED:To https://github.com/org/repo\n ! [rejected] main -> main (non-fast-forward)\nerror: failed to push some refs\nhint: Updates were rejected because the tip of your current branch is behind';
    vi.mocked(publishBranch).mockRejectedValue(pushRejectedError);

    const { showToast } = renderWithToasts(<UnsavedChangesModal {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /publish & switch/i }));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(
      'There are newer changes on GitHub than you have locally. Pull the latest changes first, then try again.',
      'info'
    );
  });

  it('routes unrecognized publish error to error toast with raw message', async () => {
    const unexpectedError = 'Some completely unexpected internal error';
    vi.mocked(publishBranch).mockRejectedValue(unexpectedError);

    const { showToast } = renderWithToasts(<UnsavedChangesModal {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /publish & switch/i }));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(
      'Failed to publish: Some completely unexpected internal error',
      'error'
    );
  });

  it('routes recognized discard failure to info toast with humanized message', async () => {
    const gitError =
      'error: Your local changes to the following files would be overwritten by checkout:\n\tfile.txt\nPlease commit your changes or stash them before you switch branches.';
    vi.mocked(discardChanges).mockRejectedValue(gitError);

    const { showToast } = renderWithToasts(<UnsavedChangesModal {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /discard changes/i }));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(
      'You have unsaved changes that would be lost. Save or discard them first, then try again.',
      'info'
    );
  });

  it('routes unrecognized discard error to error toast with raw message', async () => {
    const unexpectedError = 'Database disk is full';
    vi.mocked(discardChanges).mockRejectedValue(unexpectedError);

    const { showToast } = renderWithToasts(<UnsavedChangesModal {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /discard changes/i }));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(
      'Failed to discard changes: Database disk is full',
      'error'
    );
  });
});
