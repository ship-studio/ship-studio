import { useCommands } from './useCommands';
import { BranchIcon, PlusIcon, PullIcon, UploadIcon } from '../components/icons';

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
  /** Pulls the latest changes from GitHub (routes conflicts to the resolver) */
  handlePullLatest: () => void;
  /** Push/pull commands only make sense with a connected GitHub repo */
  isGitHubConnected: boolean;
}

const PullRequestGlyph = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M6 9v6" />
    <circle cx="18" cy="18" r="3" />
    <path d="M13 6h3a2 2 0 0 1 2 2v7" />
  </svg>
);

const AlertGlyph = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

export function useWorkspaceCommands({
  currentBranch,
  hasUncommittedChanges,
  hasConflicts,
  setWorkspaceTab,
  setShowSubmitReview,
  handleResolveConflicts,
  openPushDropdown,
  handlePullLatest,
  isGitHubConnected,
}: UseWorkspaceCommandsParams) {
  useCommands(
    () => [
      {
        id: 'git.push',
        title: 'Push to GitHub',
        subtitle: hasUncommittedChanges ? 'Commits your changes, then pushes' : undefined,
        icon: <UploadIcon size={14} />,
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
        when: 'project',
        keywords: ['checkout', 'change', 'git'],
        run: () => setWorkspaceTab('branches'),
      },
      {
        id: 'branch.create',
        title: 'Create new branch…',
        icon: <PlusIcon size={14} />,
        category: 'branch',
        when: 'project',
        keywords: ['new', 'git', 'checkout -b'],
        run: () => setWorkspaceTab('branches'),
      },
      {
        id: 'branch.submitReview',
        title: 'Submit for review',
        subtitle: hasUncommittedChanges
          ? 'You have uncommitted changes — they will be committed first'
          : undefined,
        icon: <PullRequestGlyph />,
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
        icon: <PullRequestGlyph />,
        category: 'branch',
        when: 'project',
        keywords: ['prs', 'reviews'],
        run: () => setWorkspaceTab('prs'),
      },
      {
        id: 'branch.resolveConflicts',
        title: 'Resolve merge conflicts',
        icon: <AlertGlyph />,
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
      handlePullLatest,
      isGitHubConnected,
    ]
  );
}
