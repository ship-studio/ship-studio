import { useCommands } from './useCommands';
import {
  BranchIcon,
  PlusIcon,
  PullIcon,
  PullRequestIcon,
  PushIcon,
  WarningIcon,
} from '@/components/icons';

/**
 * Workspace-scoped palette commands (Branches, PR flows).
 *
 * Called from `WorkspaceView`, where the necessary handlers live (inside
 * `useBranchManagement` + `useWorkspaceLayout`). The command palette picks
 * these up automatically via the global registry — no prop drilling to
 * `CommandPaletteHost` needed.
 *
 * Follows the "feature owns its commands" rule in CLAUDE.md.
 */
export interface UseWorkspaceCommandsParams {
  currentBranch: string | null;
  hasUncommittedChanges: boolean;
  hasConflicts: boolean;
  setWorkspaceTab: (tab: 'preview' | 'code' | 'branches' | 'prs') => void;
  setShowSubmitReview: (branch: string | null) => void;
  handleResolveConflicts: () => void | Promise<void>;
  /** Opens the header Push dropdown */
  openPushDropdown: () => void;
  /** Opens the header Branches workflow menu */
  openBranchesMenu: () => void;
  /** Opens the full Branches view with its creation form active. */
  openCreateBranch: () => void;
  /** Pulls the latest changes from GitHub (routes conflicts to the resolver) */
  handlePullLatest: () => void;
  /**
   * Push/pull need a remote, and the Branches/PRs panes only render for a
   * connected repo — commands that land there are hidden otherwise (#612).
   */
  isGitHubConnected: boolean;
  /** Opens the "New worktree" modal. */
  openWorktreeCreate: () => void;
  /** Worktree commands only make sense in a git repo (list is empty otherwise). */
  hasWorktreeData: boolean;
}

export function useWorkspaceCommands({
  currentBranch,
  hasUncommittedChanges,
  hasConflicts,
  setWorkspaceTab,
  setShowSubmitReview,
  handleResolveConflicts,
  openPushDropdown,
  openBranchesMenu,
  openCreateBranch,
  handlePullLatest,
  isGitHubConnected,
  openWorktreeCreate,
  hasWorktreeData,
}: UseWorkspaceCommandsParams) {
  useCommands(
    () => [
      {
        id: 'git.push',
        title: 'Push to GitHub',
        subtitle: hasUncommittedChanges ? 'Commits your changes, then pushes' : undefined,
        icon: <PushIcon size={14} />,
        category: 'branch',
        when: ({ kind }) => kind === 'project' && isGitHubConnected,
        keywords: ['publish', 'sync', 'upload', 'commit', 'git'],
        run: openPushDropdown,
      },
      {
        id: 'git.pull',
        title: 'Pull latest from GitHub',
        icon: <PullIcon size={14} />,
        category: 'branch',
        when: ({ kind }) => kind === 'project' && isGitHubConnected,
        keywords: ['sync', 'fetch', 'update', 'download', 'git'],
        run: handlePullLatest,
      },
      {
        id: 'branch.switch',
        title: 'Switch branch…',
        subtitle: currentBranch ? `Currently on ${currentBranch}` : undefined,
        icon: <BranchIcon size={14} />,
        category: 'branch',
        // `useWorkspaceLayout` projects the branches/prs tabs back to preview
        // when GitHub isn't connected, so without this gate the command was
        // listed, selectable, and did nothing at all (issue #612).
        when: ({ kind }) => kind === 'project' && isGitHubConnected,
        keywords: ['checkout', 'change', 'git'],
        run: openBranchesMenu,
      },
      {
        id: 'branch.create',
        title: 'Create new branch…',
        icon: <PlusIcon size={14} />,
        category: 'branch',
        when: ({ kind }) => kind === 'project' && isGitHubConnected,
        keywords: ['new', 'git', 'checkout -b'],
        run: openCreateBranch,
      },
      {
        id: 'branch.submitReview',
        title: 'Submit for review',
        subtitle: hasUncommittedChanges
          ? 'You have uncommitted changes — they will be committed first'
          : undefined,
        icon: <PullRequestIcon size={14} />,
        category: 'branch',
        // Only available on a feature branch — opening a PR from main/
        // master into itself isn't a real workflow.
        when: ({ kind }) =>
          kind === 'project' &&
          currentBranch !== null &&
          currentBranch !== 'main' &&
          currentBranch !== 'master',
        keywords: ['pr', 'pull request', 'github'],
        run: () => setShowSubmitReview(currentBranch ?? ''),
      },
      {
        id: 'branch.viewPRs',
        title: 'View open pull requests',
        icon: <PullRequestIcon size={14} />,
        category: 'branch',
        when: ({ kind }) => kind === 'project' && isGitHubConnected,
        keywords: ['prs', 'reviews'],
        run: () => setWorkspaceTab('prs'),
      },
      {
        id: 'worktree.create',
        title: 'New worktree…',
        subtitle: 'Work on another branch side by side',
        icon: <BranchIcon size={14} />,
        category: 'branch',
        when: ({ kind }) => kind === 'project' && hasWorktreeData,
        keywords: ['worktree', 'parallel', 'branch', 'git', 'side by side'],
        run: openWorktreeCreate,
      },
      {
        id: 'worktree.manage',
        title: 'Manage worktrees',
        icon: <BranchIcon size={14} />,
        category: 'branch',
        // Lives inside the Branches pane, so it needs the same gate (#612).
        when: ({ kind }) => kind === 'project' && hasWorktreeData && isGitHubConnected,
        keywords: ['worktree', 'remove', 'prune', 'git'],
        run: () => setWorkspaceTab('branches'),
      },
      {
        id: 'branch.resolveConflicts',
        title: 'Resolve merge conflicts',
        icon: <WarningIcon size={14} />,
        category: 'branch',
        when: ({ kind }) => kind === 'project' && hasConflicts,
        keywords: ['merge', 'conflict'],
        run: () => void handleResolveConflicts(),
      },
    ],
    [
      currentBranch,
      hasUncommittedChanges,
      hasConflicts,
      setWorkspaceTab,
      setShowSubmitReview,
      handleResolveConflicts,
      openPushDropdown,
      openBranchesMenu,
      openCreateBranch,
      handlePullLatest,
      isGitHubConnected,
      openWorktreeCreate,
      hasWorktreeData,
    ]
  );
}
