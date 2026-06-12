/**
 * BranchPRTabContainer — renders the branches and PRs tab panes inside the
 * preview pane, plus the ConnectOverlay fallback when GitHub isn't connected.
 * Extracted from WorkspaceView to reduce LOC and group the sidebar tab logic.
 *
 * @module components/workspace/BranchPRTabContainer
 */

import { BranchesTab } from '../branches/BranchesTab';
import { PullRequestsTab } from '../branches/PullRequestsTab';
import { ConnectOverlay } from '../ConnectOverlay';
import type { BranchInfo, PullRequestInfo } from '../../lib/branches';
import type { IntegrationState } from '../../hooks/useIntegrationStatus';

export interface BranchPRTabContainerProps {
  workspaceTab: 'preview' | 'code' | 'branches' | 'prs';
  setWorkspaceTab: (tab: 'preview' | 'code' | 'branches' | 'prs') => void;
  /** Whether the project has its own preview surface (web iframe or mobile
   *  device mirror). Projects without one show the branches pane in the
   *  "preview" tab slot; projects with one must not. */
  hasPreview: boolean;
  /** Whether the project type has finished detecting. While it's still resolving,
   *  `hasPreview` is transiently false, so we must NOT fall back to the branches
   *  pane (and its GitHub connect overlay) on the preview tab — that's the ~1s
   *  "Connect GitHub" flash seen when opening a mobile project. */
  projectTypeResolved: boolean;
  integrations: IntegrationState;
  branches: BranchInfo[];
  openPRs: PullRequestInfo[];
  currentBranch: string | null;
  projectPath: string;
  handleBranchSwitch: (branchName: string) => Promise<void>;
  handleRestartDevServer: () => Promise<void>;
  setShowSubmitReview: (branch: string | null) => void;
  fetchBranchInfo: (projectPath: string) => Promise<void>;
  handleResolveConflicts: (headBranch?: string, baseBranch?: string) => Promise<void>;
  handleGitHubConnect: () => void;
}

export function BranchPRTabContainer({
  workspaceTab,
  setWorkspaceTab,
  hasPreview,
  projectTypeResolved,
  integrations,
  branches,
  openPRs,
  currentBranch,
  projectPath,
  handleBranchSwitch,
  handleRestartDevServer,
  setShowSubmitReview,
  fetchBranchInfo,
  handleResolveConflicts,
  handleGitHubConnect,
}: BranchPRTabContainerProps) {
  const showBranchesPane =
    workspaceTab === 'branches' ||
    (!hasPreview && projectTypeResolved && workspaceTab === 'preview');
  const showPRsPane = workspaceTab === 'prs';
  const githubConnected =
    integrations.github.cliStatus.authenticated &&
    integrations.projectGithub?.status === 'connected';

  return (
    <>
      {showBranchesPane &&
        (githubConnected ? (
          <BranchesTab
            branches={branches}
            currentBranch={currentBranch || ''}
            projectPath={projectPath}
            githubUsername={integrations.github.username}
            openPRs={openPRs}
            onBranchSwitch={(branchName) => void handleBranchSwitch(branchName)}
            onSubmitForReview={(branchName) => setShowSubmitReview(branchName)}
            onViewPR={() => setWorkspaceTab('prs')}
            onRefresh={() => void fetchBranchInfo(projectPath)}
          />
        ) : (
          <div style={{ position: 'relative', flex: 1 }}>
            <ConnectOverlay
              title="Connect GitHub to manage branches"
              description="Create branches, switch between versions, and collaborate with your team."
              onConnect={() => void handleGitHubConnect()}
            />
          </div>
        ))}
      {showPRsPane &&
        (githubConnected ? (
          <PullRequestsTab
            projectPath={projectPath}
            githubUsername={integrations.github.username}
            currentBranch={currentBranch || undefined}
            onRefresh={() => void fetchBranchInfo(projectPath)}
            onBranchSwitch={(branchName) => {
              void handleBranchSwitch(branchName);
              // TODO: Chain off handleBranchSwitch promise instead of arbitrary timeout — branch switch may take longer or shorter than 1.5s
              setTimeout(() => void handleRestartDevServer(), 1500);
            }}
            onNavigateToBranches={() => setWorkspaceTab('branches')}
            onResolveConflicts={(headBranch, baseBranch) =>
              void handleResolveConflicts(headBranch, baseBranch)
            }
          />
        ) : (
          <div style={{ position: 'relative', flex: 1 }}>
            <ConnectOverlay
              title="Connect GitHub to view pull requests"
              description="Submit code for review, merge changes, and track your team's work."
              onConnect={() => void handleGitHubConnect()}
            />
          </div>
        ))}
    </>
  );
}
