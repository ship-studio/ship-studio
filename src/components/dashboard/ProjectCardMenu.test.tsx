import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ProjectCardMenu } from './ProjectCardMenu';

function renderMenu(onOpenSettings = vi.fn()) {
  return render(
    <ProjectCardMenu
      onOpenSettings={onOpenSettings}
      hideMainBranchWarning={false}
      onToggleMainBranchWarning={vi.fn()}
      onDelete={vi.fn()}
    />
  );
}

describe('ProjectCardMenu', () => {
  it('opens project settings from the project options menu', async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    renderMenu(onOpenSettings);

    await user.click(screen.getByRole('button', { name: 'Project options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Project Settings' }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
