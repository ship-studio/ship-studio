import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BranchesMenu } from './BranchesMenu';
import type { BranchInfo, PullRequestInfo } from '../../lib/branches';

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl,
}));

vi.mock('./GitHubButton', () => ({
  GitHubButton: () => <button type="button">Connect GitHub</button>,
}));

const branch = (name: string, lastCommitDate: number, isCurrent = false): BranchInfo => ({
  name,
  isCurrent,
  isRemote: false,
  isDefault: name === 'main',
  lastCommitDate,
  lastCommitAuthor: 'Martin',
  aheadOfMain: 0,
  behindOfMain: 0,
  pushed: true,
});

const connectedStatus = {
  status: 'connected' as const,
  github_repo: 'martin/ship-studio',
  github_url: 'https://github.com/martin/ship-studio',
};

function makeProps(overrides: Partial<Parameters<typeof BranchesMenu>[0]> = {}) {
  return {
    githubState: {
      cliStatus: { installed: true, authenticated: true },
      username: 'martin',
    },
    projectStatus: connectedStatus,
    projectPath: '/test/project',
    projectName: 'Ship Studio',
    currentBranch: 'feature/menu',
    branches: [branch('feature/menu', 10, true), branch('older', 20), branch('newer', 30)],
    openPRs: [] as PullRequestInfo[],
    isPulling: false,
    isBranchSwitching: false,
    isRepositoryViewActive: false,
    isOpen: true,
    onOpenChange: vi.fn(),
    onPullLatest: vi.fn(),
    onBranchSwitch: vi.fn(),
    onViewBranches: vi.fn(),
    onCreateBranch: vi.fn(),
    onViewPRs: vi.fn(),
    onStartPR: vi.fn(),
    onGitHubConnect: vi.fn(),
    onGitHubStatusChange: vi.fn(),
    ...overrides,
  };
}

describe('BranchesMenu', () => {
  it('contains pull, current/recent branches, PR actions, and full-view links', () => {
    const props = makeProps();
    render(<BranchesMenu {...props} />);

    fireEvent.click(screen.getByText('Pull latest from GitHub'));
    expect(props.onPullLatest).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('feature/menu')).toHaveLength(2);
    expect(screen.getByText('newer')).toBeInTheDocument();
    expect(screen.getByText('New pull request')).toBeInTheDocument();
    expect(screen.getByText('View all branches')).toBeInTheDocument();
    expect(screen.getByText('New branch')).toBeInTheDocument();
    expect(screen.getByText('View all pull requests')).toBeInTheDocument();
    expect(screen.getByText('Open in GitHub')).toBeInTheDocument();

    expect(screen.getByText('Pull latest from GitHub').closest('button')).toHaveClass(
      'button--default'
    );
    expect(screen.getByText('New branch').closest('button')).toHaveClass('button--ghost');
    expect(screen.getByText('New pull request').closest('button')).toHaveClass('button--ghost');
    expect(
      screen.getByText('New branch').closest('button')?.querySelector('[data-icon-name="AddIcon"]')
    ).toBeTruthy();
    expect(
      screen
        .getByText('New pull request')
        .closest('button')
        ?.querySelector('[data-icon-name="AddIcon"]')
    ).toBeTruthy();
    expect(screen.getByText('New pull request')).toHaveClass('branches-menu-row-label');
    expect(
      screen
        .getByText('New pull request')
        .closest('.branches-menu-action')
        ?.querySelector('.branches-menu-row-meta')
    ).toHaveClass('branches-menu-row-meta');

    const header = screen.getByRole('heading', { name: 'Branches' }).parentElement;
    expect(header).toHaveClass('branches-menu-header');
    const repositoryButton = screen.getByRole('button', { name: /Open in GitHub/ });
    expect(repositoryButton).toHaveClass('text-button');
    expect(header).toContainElement(repositoryButton);

    expect(screen.getByLabelText('3 branches')).toBeInTheDocument();
    expect(screen.getByText('View all branches').closest('button')).toHaveClass('text-button');
    expect(screen.getByText('View all pull requests').closest('button')).toHaveClass('text-button');
  });

  it('starts a pull request for the current feature branch', () => {
    const props = makeProps();
    render(<BranchesMenu {...props} />);

    fireEvent.click(screen.getByText('New pull request'));

    expect(props.onStartPR).toHaveBeenCalledWith('feature/menu');
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('uses the contextual branch icons for the trigger and branch rows', () => {
    const props = makeProps({
      currentBranch: 'main',
      branches: [branch('main', 10, true), branch('feature/menu', 20), branch('older', 30)],
    });
    const { container } = render(<BranchesMenu {...props} />);

    expect(container.querySelector('[data-icon-name="GitBranchHorizontalIcon"]')).toBeTruthy();
    const mainRow = screen.getByText('main').closest('button');
    expect(mainRow).toHaveClass('branches-menu-branch-row');
    expect(mainRow?.querySelector('.branches-menu-row-content')).toBeTruthy();
    expect(mainRow?.querySelector('[data-icon-name="GitBranchMainIcon"]')).toBeTruthy();
    expect(mainRow?.querySelector('[data-icon-name="GitBranchMainIcon"]')).toHaveAttribute(
      'width',
      '24'
    );
    const olderLabel = screen
      .getAllByText('older')
      .find((element) => element.classList.contains('branches-menu-row-label'));
    expect(
      olderLabel?.closest('button')?.querySelector('[data-icon-name="GitBranchMidIcon"]')
    ).toBeTruthy();
    expect(
      screen
        .getByText('feature/menu')
        .closest('button')
        ?.querySelector('[data-icon-name="GitBranchEndIcon"]')
    ).toBeTruthy();
  });

  it('uses the empty main-branch icon only when main has no other branches', () => {
    const props = makeProps({
      currentBranch: 'main',
      branches: [branch('main', 10, true)],
    });
    render(<BranchesMenu {...props} />);
    const mainRow = screen.getByText('main').closest('button');

    expect(mainRow?.querySelector('[data-icon-name="GitBranchMainNoneIcon"]')).toBeTruthy();
    expect(mainRow?.querySelector('[data-icon-name="GitBranchMainIcon"]')).toBeNull();
    expect(mainRow?.querySelector('[data-icon-name="GitBranchMidIcon"]')).toBeNull();
    expect(mainRow?.querySelector('[data-icon-name="GitBranchEndIcon"]')).toBeNull();
    expect(mainRow?.querySelector('[data-icon-name="GitBranchMainNoneIcon"] path')).toHaveAttribute(
      'stroke',
      'currentColor'
    );
  });

  it('starts branch creation from the menu', () => {
    const props = makeProps();
    render(<BranchesMenu {...props} />);

    fireEvent.click(screen.getByText('New branch'));

    expect(props.onCreateBranch).toHaveBeenCalledTimes(1);
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('switches a recent branch and closes the menu', () => {
    const props = makeProps();
    render(<BranchesMenu {...props} />);

    fireEvent.click(screen.getByText('newer'));
    expect(props.onBranchSwitch).toHaveBeenCalledWith('newer');
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('links to an existing PR for the current branch', () => {
    const props = makeProps({
      openPRs: [
        {
          number: 42,
          title: 'Header cleanup',
          headRef: 'feature/menu',
          baseRef: 'main',
          author: 'martin',
          state: 'OPEN',
          isDraft: false,
          mergeable: true,
          url: 'https://github.com/martin/ship-studio/pull/42',
          createdAt: '2026-07-31T00:00:00Z',
        },
      ],
    });
    render(<BranchesMenu {...props} />);

    fireEvent.click(screen.getByText('#42'));
    expect(openUrl).toHaveBeenCalledWith('https://github.com/martin/ship-studio/pull/42');
    expect(screen.getByText('Header cleanup')).toBeInTheDocument();
    expect(screen.getAllByText('feature/menu')).toHaveLength(2);
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('martin')).toBeInTheDocument();
    expect(screen.queryByText(/Opened by/)).not.toBeInTheDocument();
    expect(
      screen
        .getByText('#42')
        .closest('button')
        ?.querySelector('[data-icon-name="ExternalLinkIcon"]')
    ).toBeNull();
    expect(screen.getByText('New pull request')).toBeInTheDocument();
  });

  it('keeps repository setup inside the stable Branches trigger', () => {
    render(
      <BranchesMenu
        {...makeProps({
          githubState: {
            cliStatus: { installed: true, authenticated: false },
            username: null,
          },
          projectStatus: { status: 'no-remote', github_repo: null, github_url: null },
        })}
      />
    );

    expect(screen.getByRole('button', { name: /branches/i })).toBeInTheDocument();
    expect(screen.getByText('Connect GitHub')).toBeInTheDocument();
    expect(screen.queryByText('Pull latest from GitHub')).not.toBeInTheDocument();
  });
});
