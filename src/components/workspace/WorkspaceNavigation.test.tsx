import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceNavigation } from './WorkspaceHeader';

describe('WorkspaceNavigation', () => {
  it('keeps Workflows and the Inbox reachable from inside a project', async () => {
    // The work these two describe happens in a project. Leaving them behind on
    // Home meant a finding filed while you were working could only be found by
    // going looking for it.
    const user = userEvent.setup();
    const onGoWorkflows = vi.fn();
    const onGoInbox = vi.fn();
    render(
      <WorkspaceNavigation
        onGoHome={vi.fn()}
        onGoWorkflows={onGoWorkflows}
        onGoInbox={onGoInbox}
        isSidebarHidden={false}
        onToggleSidebar={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Workflows' }));
    expect(onGoWorkflows).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Inbox/ }));
    expect(onGoInbox).toHaveBeenCalled();
  });

  it('badges the unread count so a finding is noticed without leaving the project', () => {
    render(
      <WorkspaceNavigation
        onGoHome={vi.fn()}
        onGoWorkflows={vi.fn()}
        onGoInbox={vi.fn()}
        inboxUnreadCount={3}
        isSidebarHidden={false}
        onToggleSidebar={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Inbox — 3 unread' })).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows neither when the host does not offer them', () => {
    render(
      <WorkspaceNavigation onGoHome={vi.fn()} isSidebarHidden={false} onToggleSidebar={vi.fn()} />
    );
    expect(screen.queryByRole('button', { name: 'Workflows' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Inbox/ })).not.toBeInTheDocument();
  });
});
