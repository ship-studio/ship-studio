/**
 * Compact-mode branches/PRs side panel.
 *
 * Extracted from WorkspaceView during Block 7 of the DX refactor — this is the
 * left-side overlay that slides in when the user picks "Branches" or "Pull
 * Requests" in compact mode, with a back button, pin/expand controls, and the
 * BranchesTab / PullRequestsTab bodies.
 */

import { ArrowLeftIcon, PinIcon, ExpandIcon } from './icons';
import { BranchesTab } from './BranchesTab';
import { PullRequestsTab } from './PullRequestsTab';
import type { BranchInfo, PullRequestInfo } from '../lib/branches';
import type { IntegrationState } from '../hooks/useIntegrationStatus';

export type CompactView = 'terminal' | 'branches' | 'prs';

interface CompactBranchPRViewProps {
  compactView: CompactView;
  setCompactView: (view: CompactView) => void;
  isPinned: boolean;
  onPinToggle: () => void | Promise<void>;
  onExpandToFull: () => void | Promise<void>;
  projectPath: string;
  currentBranch: string;
  branches: BranchInfo[];
  openPRs: PullRequestInfo[];
  integrations: IntegrationState;
  /** Called when user switches branches from the Branches tab. */
  onBranchSwitchFromBranches: (branchName: string) => void;
  /** Called when user checks out a PR branch from the Pull Requests tab. */
  onBranchSwitchFromPR: (branchName: string) => void;
  onSubmitForReview: (branchName: string) => void;
  onRefresh: () => void;
  onResolveConflicts: (headBranch: string, baseBranch: string) => void;
}

export function CompactBranchPRView({
  compactView,
  setCompactView,
  isPinned,
  onPinToggle,
  onExpandToFull,
  projectPath,
  currentBranch,
  branches,
  openPRs,
  integrations,
  onBranchSwitchFromBranches,
  onBranchSwitchFromPR,
  onSubmitForReview,
  onRefresh,
  onResolveConflicts,
}: CompactBranchPRViewProps) {
  const gitHubReady =
    integrations.github.cliStatus.authenticated &&
    integrations.projectGithub?.status === 'connected';

  return (
    <div className={`compact-branches-view ${compactView === 'terminal' ? 'compact-hidden' : ''}`}>
      <div className="compact-branches-header">
        <button className="compact-back-btn" onClick={() => setCompactView('terminal')}>
          <ArrowLeftIcon size={12} />
          <span>Terminal</span>
        </button>
        <span className="compact-branches-title">
          {compactView === 'branches' ? 'Branches' : 'Pull Requests'}
        </span>
        <div className="compact-mode-controls" style={{ marginLeft: 'auto' }}>
          <button
            className={`compact-control-btn ${isPinned ? 'active' : ''}`}
            onClick={() => void onPinToggle()}
            title={isPinned ? 'Unpin from top' : 'Pin to top'}
          >
            <PinIcon size={12} />
          </button>
          <button
            className="compact-control-btn"
            onClick={() => void onExpandToFull()}
            title="Expand to full mode"
          >
            <ExpandIcon size={12} />
          </button>
        </div>
      </div>
      <div className="compact-branches-content">
        {compactView === 'branches' && gitHubReady && (
          <BranchesTab
            branches={branches}
            currentBranch={currentBranch}
            projectPath={projectPath}
            githubUsername={integrations.github.username}
            openPRs={openPRs}
            onBranchSwitch={(branchName) => {
              onBranchSwitchFromBranches(branchName);
              setCompactView('terminal');
            }}
            onSubmitForReview={onSubmitForReview}
            onViewPR={() => setCompactView('prs')}
            onRefresh={onRefresh}
          />
        )}
        {compactView === 'prs' && gitHubReady && (
          <PullRequestsTab
            projectPath={projectPath}
            githubUsername={integrations.github.username}
            currentBranch={currentBranch || undefined}
            onRefresh={onRefresh}
            onBranchSwitch={onBranchSwitchFromPR}
            onNavigateToBranches={() => setCompactView('branches')}
            onResolveConflicts={onResolveConflicts}
          />
        )}
      </div>
    </div>
  );
}
