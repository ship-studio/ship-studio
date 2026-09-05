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

  it('keeps a cadence the preset rail cannot express', async () => {
    // An agent can write `every 20m` or `daily at 06:30`; the rail has no
    // matching preset, so saving used to normalise it away and silently move
    // when the workflow ran.
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const existing = {
      id: '/p/demo::odd',
      slug: 'odd',
      name: 'Odd cadence',
      icon: null,
      description: '',
      agentId: null,
      projectPath: '/p/demo',
      projectName: 'demo',
      trigger: { kind: 'daily', atHour: 6, atMinute: 30 },
      permission: 'read-only',
      prompt: 'Look at something.',
      severityFloor: 'info',
      autoRun: true,
      filePath: '/p/demo/.shipstudio/workflows/odd.md',
      updatedAt: null,
      nextRunAt: null,
      isRunning: false,
      runningSince: null,
      runs: [],
    } as const;

    render(
      <WorkflowEditorModal
        workflow={existing as never}
        projects={projects}
        onClose={vi.fn()}
        onSave={onSave}
        onDelete={vi.fn()}
      />
    );

    await user.clear(screen.getByLabelText('Workflow name'));
    await user.type(screen.getByLabelText('Workflow name'), 'Renamed');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const draft = onSave.mock.calls[0]?.[2] as { trigger: { atHour: number; atMinute: number } };
    expect(draft.trigger).toEqual({ kind: 'daily', atHour: 6, atMinute: 30 });
  });

  it('replaces the saved cadence once the trigger itself is changed', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const existing = {
      id: '/p/demo::odd',
      slug: 'odd',
      name: 'Odd cadence',
      icon: null,
      description: '',
      agentId: null,
      projectPath: '/p/demo',
      projectName: 'demo',
      trigger: { kind: 'daily', atHour: 6, atMinute: 30 },
      permission: 'read-only',
      prompt: 'Look at something.',
      severityFloor: 'info',
      autoRun: true,
      filePath: '/p/demo/.shipstudio/workflows/odd.md',
      updatedAt: null,
      nextRunAt: null,
      isRunning: false,
      runningSince: null,
      runs: [],
    } as const;

    render(
      <WorkflowEditorModal
        workflow={existing as never}
        projects={projects}
        onClose={vi.fn()}
        onSave={onSave}
        onDelete={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Weekly' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const draft = onSave.mock.calls[0]?.[2] as { trigger: { kind: string } };
    expect(draft.trigger.kind).toBe('weekly');
  });
});
