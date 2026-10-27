/**
 * The Create GitHub Repository dialog is rendered by GitHubButton, which lives
 * inside the Branches dropdown's menu. The dialog portals to the modal root, so
 * every click in it lands outside the dropdown's container — and the dropdown's
 * click-outside dismissal used to close the menu, unmounting GitHubButton and
 * the dialog's own `showCreateModal` state with it. The dialog vanished on the
 * first click into any of its fields, which made creating a repository from the
 * menu impossible.
 */
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BranchesMenu } from './BranchesMenu';
import { pushToGitHub } from '../../lib/github';
import type { PullRequestInfo } from '../../lib/branches';

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

// Plain async implementations, not `mockResolvedValue`: the suite resets mocks
// between tests, which would strip a one-shot resolved value and leave the
// component awaiting `undefined`.
vi.mock('../../lib/github', () => ({
  pushToGitHub: vi.fn(() => Promise.resolve()),
  getGitHubOrgs: vi.fn(() => Promise.resolve(['acme-co'])),
  getGitHubUsername: vi.fn(() => Promise.resolve('martin')),
  // The menu names the remote in its copy. This is the real implementation's
  // answer for a project with no remote: nothing to name.
  remoteLabel: vi.fn(() => null),
}));

/** Mirrors the app: the menu's open state is owned by its parent. */
function Harness() {
  const [isOpen, setIsOpen] = useState(true);
  return (
    <BranchesMenu
      githubState={{
        cliStatus: { installed: true, authenticated: true },
        username: 'martin',
      }}
      // Not connected — the setup pane with "Create Repo" renders. A project
      // with no remote at all has no host or forge to report either.
      projectStatus={{
        status: 'no-remote',
        github_repo: null,
        github_url: null,
        remote_host: null,
        remote_forge: null,
      }}
      projectPath="/test/project"
      projectName="ship-studio"
      currentBranch="main"
      branches={[]}
      openPRs={[] as PullRequestInfo[]}
      isPulling={false}
      isBranchSwitching={false}
      isRepositoryViewActive={false}
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      onPullLatest={vi.fn()}
      onSwitchBranch={vi.fn()}
      onViewBranches={vi.fn()}
      onCreateBranch={vi.fn()}
      onViewPRs={vi.fn()}
      onStartPR={vi.fn()}
      onGitHubConnect={vi.fn()}
      onGitHubStatusChange={vi.fn()}
    />
  );
}

const dialog = () => screen.queryByRole('dialog', { name: 'Create GitHub Repository' });

async function openDialog() {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByTitle('Create GitHub repository'));
  await waitFor(() => expect(dialog()).not.toBeNull());
  return user;
}

describe('Create GitHub Repository dialog', () => {
  it('stays open when the user clicks its repository-name field', async () => {
    const user = await openDialog();

    await user.click(screen.getByPlaceholderText('my-project'));

    expect(dialog()).not.toBeNull();
  });

  it('stays open across the whole form, and creates the repository', async () => {
    const user = await openDialog();

    const name = screen.getByPlaceholderText('my-project');
    await user.clear(name);
    await user.type(name, 'my-new-repo');
    await user.click(screen.getByText('Public'));
    await user.selectOptions(screen.getByRole('combobox'), 'acme-co');

    expect(dialog()).not.toBeNull();
    expect(screen.getByDisplayValue('my-new-repo')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Create Repository' }));

    await waitFor(() =>
      expect(pushToGitHub).toHaveBeenCalledWith({
        projectPath: '/test/project',
        repoName: 'acme-co/my-new-repo',
        isPrivate: false,
      })
    );
  });

  it('still closes when the user clicks the backdrop outside it', async () => {
    const user = await openDialog();

    await user.click(document.querySelector('.modal-frame-overlay') as HTMLElement);

    await waitFor(() => expect(dialog()).toBeNull());
  });
});
