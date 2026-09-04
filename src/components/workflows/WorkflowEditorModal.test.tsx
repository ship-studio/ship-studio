import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowEditorModal } from './WorkflowEditorModal';

vi.mock('../../contexts/ToastContext', () => ({
  useOptionalToast: () => ({ showToast: vi.fn() }),
}));

const projects = [{ name: 'demo', path: '/p/demo' }];

function renderNew() {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(
    <WorkflowEditorModal
      workflow="new"
      projects={projects}
      defaultProjectPath="/p/demo"
      onClose={vi.fn()}
      onSave={onSave}
      onDelete={vi.fn()}
    />
  );
  return { onSave };
}

describe('WorkflowEditorModal', () => {
  it('opens on the picker with a template already chosen', () => {
    // A dead primary button on the first screen of a two-step flow reads as a
    // broken dialog, not as an invitation to choose.
    renderNew();
    expect(screen.getByRole('listbox', { name: 'Templates' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use this template' })).toBeEnabled();
  });

  it('carries the chosen template into the form', async () => {
    const user = userEvent.setup();
    renderNew();
    await user.click(screen.getByRole('option', { name: /Copy review/ }));
    await user.click(screen.getByRole('button', { name: 'Use this template' }));

    expect(screen.getByLabelText('Workflow name')).toHaveValue('Copy review');
    // The instruction arrives filled in, so the next step is editing rather
    // than staring at an empty box.
    expect(screen.getByDisplayValue(/Read the user-facing strings/)).toBeInTheDocument();
  });

  it('goes straight to an empty form when starting from scratch', async () => {
    const user = userEvent.setup();
    renderNew();
    await user.click(screen.getByRole('button', { name: 'Start from scratch' }));

    expect(screen.queryByRole('listbox', { name: 'Templates' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Workflow name')).toHaveValue('');
    // Nothing to save until the person writes something.
    expect(screen.getByRole('button', { name: 'Create workflow' })).toBeDisabled();
  });

  it('can go back to the picker from the form', async () => {
    const user = userEvent.setup();
    renderNew();
    await user.click(screen.getByRole('button', { name: 'Use this template' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('listbox', { name: 'Templates' })).toBeInTheDocument();
  });
});
