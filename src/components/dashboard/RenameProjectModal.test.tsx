/**
 * Tests for RenameProjectModal — rename a project's folder from the dashboard.
 *
 * Covers:
 *   - submit calls onRename with the trimmed new name and closes on success
 *   - submit disabled while the name is unchanged or empty
 *   - backend CommandError objects render their message (regression: these
 *     used to display as "[object Object]")
 *   - plain string / Error rejections also render readable messages
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RenameProjectModal } from './RenameProjectModal';

describe('RenameProjectModal', () => {
  const onClose = vi.fn();
  const onRename = vi.fn<(newName: string) => Promise<void>>();

  beforeEach(() => {
    vi.clearAllMocks();
    onRename.mockResolvedValue(undefined);
  });

  function open() {
    render(
      <RenameProjectModal
        isOpen={true}
        onClose={onClose}
        currentName="my-project"
        onRename={onRename}
      />
    );
  }

  it('renames with the trimmed value and closes on success', async () => {
    open();
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: '  renamed-project  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(onRename).toHaveBeenCalledWith('renamed-project'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('disables submit while the name is unchanged', () => {
    open();
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
  });

  it('renders the message from a CommandError object (not [object Object])', async () => {
    onRename.mockRejectedValue({
      type: 'Other',
      message: 'This project is open in another window. Close that window, then rename.',
    });
    open();
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'new-name' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() =>
      expect(
        screen.getByText('This project is open in another window. Close that window, then rename.')
      ).toBeInTheDocument()
    );
    expect(screen.queryByText(/object Object/)).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders a Validation CommandError with field and reason', async () => {
    onRename.mockRejectedValue({
      type: 'Validation',
      field: 'new_name',
      reason: 'Project name cannot contain slashes',
    });
    open();
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'a/b' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() =>
      expect(screen.getByText(/Project name cannot contain slashes/)).toBeInTheDocument()
    );
  });

  it('renders plain string rejections as-is', async () => {
    onRename.mockRejectedValue('Project not found');
    open();
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'new-name' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(screen.getByText('Project not found')).toBeInTheDocument());
  });
});
