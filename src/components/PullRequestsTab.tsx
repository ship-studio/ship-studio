/**
 * Pull Requests tab for workspace.
 *
 * Shows open and recently merged pull requests.
 *
 * @module components/PullRequestsTab
 */

import { useState, useEffect } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  PullRequestInfo,
  listPullRequests,
  mergePullRequest,
  deleteBranch,
  switchBranch,
} from '../lib/branches';
import { ExternalLinkIcon, WarningIcon, BranchIcon } from './icons';

interface PullRequestsTabProps {
  /** Project path for PR operations */
  projectPath: string;
  /** GitHub username for highlighting own PRs */
  githubUsername: string | null;
  /** Callback to refresh after merge */
  onRefresh: () => void;
  /** Callback for toast notifications */
  onToast?: (message: string, type?: 'success' | 'error') => void;
  /** Callback when switching branches */
  onBranchSwitch?: (branchName: string) => void;
  /** Callback to navigate to branches tab */
  onNavigateToBranches?: () => void;
  /** Callback to resolve conflicts for a PR (headBranch, baseBranch) */
  onResolveConflicts?: (headBranch: string, baseBranch: string) => void;
}

export function PullRequestsTab({
  projectPath,
  githubUsername,
  onRefresh,
  onToast,
  onBranchSwitch,
  onNavigateToBranches,
  onResolveConflicts,
}: PullRequestsTabProps) {
  const [pullRequests, setPullRequests] = useState<PullRequestInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [mergingPr, setMergingPr] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [postMergeInfo, setPostMergeInfo] = useState<{
    branchName: string;
    baseBranch: string;
  } | null>(null);
  const [isCleaningUp, setIsCleaningUp] = useState(false);

  // Fetch pull requests
  useEffect(() => {
    void fetchPullRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  const fetchPullRequests = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const prs = await listPullRequests(projectPath);
      setPullRequests(prs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  };

  const handleMerge = async (prNumber: number, headRef: string, baseRef: string) => {
    setMergingPr(prNumber);
    try {
      await mergePullRequest(projectPath, prNumber);
      onToast?.('Pull request merged', 'success');
      await fetchPullRequests();
      onRefresh();
      // Show post-merge cleanup dialog
      setPostMergeInfo({ branchName: headRef, baseBranch: baseRef });
    } catch (e) {
      onToast?.(`Failed to merge: ${String(e)}`, 'error');
    } finally {
      setMergingPr(null);
    }
  };

  const handlePostMergeCleanup = async () => {
    if (!postMergeInfo) return;
    setIsCleaningUp(true);
    try {
      // Switch to base branch (usually main)
      const result = await switchBranch(projectPath, postMergeInfo.baseBranch, true);
      if (result.success) {
        onBranchSwitch?.(postMergeInfo.baseBranch);
        // Delete the merged branch
        await deleteBranch(projectPath, postMergeInfo.branchName, true);
        onToast?.(
          `Switched to ${postMergeInfo.baseBranch} and deleted ${postMergeInfo.branchName}`,
          'success'
        );
        onRefresh();
      } else {
        onToast?.(result.error || 'Failed to switch branch', 'error');
      }
    } catch (e) {
      onToast?.(`Cleanup failed: ${String(e)}`, 'error');
    } finally {
      setIsCleaningUp(false);
      setPostMergeInfo(null);
    }
  };

  // Group PRs by state
  const openPrs = pullRequests.filter((pr) => pr.state === 'OPEN');
  const mergedPrs = pullRequests.filter((pr) => pr.state === 'MERGED').slice(0, 5);

  if (isLoading) {
    return (
      <div className="prs-tab">
        <div className="prs-tab-loading">
          <div className="branch-item-spinner" />
          <span>Loading pull requests...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="prs-tab">
        <div className="prs-tab-error">
          <p>Failed to load pull requests</p>
          <button onClick={() => void fetchPullRequests()}>Try Again</button>
        </div>
      </div>
    );
  }

  return (
    <div className="prs-tab">
      {/* Open PRs */}
      <div className="prs-tab-section">
        <div className="prs-tab-section-header">Open</div>
        {openPrs.length === 0 ? (
          <div className="prs-tab-empty-state">
            <div className="prs-tab-empty-icon">
              <BranchIcon size={32} />
            </div>
            <h3 className="prs-tab-empty-title">No open pull requests</h3>
            <p className="prs-tab-empty-description">
              Pull requests let you propose changes and get feedback before merging into the main
              branch. Create a branch, make your changes, then submit it for review.
            </p>
            {onNavigateToBranches && (
              <button className="prs-tab-empty-action" onClick={onNavigateToBranches}>
                Go to Branches
              </button>
            )}
          </div>
        ) : (
          openPrs.map((pr) => (
            <PrCard
              key={pr.number}
              pr={pr}
              isOwn={pr.author === githubUsername}
              isMerging={mergingPr === pr.number}
              onMerge={() => void handleMerge(pr.number, pr.headRef, pr.baseRef)}
              onResolveConflicts={onResolveConflicts}
            />
          ))
        )}
      </div>

      {/* Recently Merged */}
      {mergedPrs.length > 0 && (
        <div className="prs-tab-section">
          <div className="prs-tab-section-header">Recently Merged</div>
          {mergedPrs.map((pr) => (
            <PrCard
              key={pr.number}
              pr={pr}
              isOwn={pr.author === githubUsername}
              isMerging={false}
            />
          ))}
        </div>
      )}

      {/* Post-merge cleanup modal */}
      {postMergeInfo && (
        <div className="post-merge-modal" onClick={() => !isCleaningUp && setPostMergeInfo(null)}>
          <div className="post-merge-content" onClick={(e) => e.stopPropagation()}>
            <div className="post-merge-header">
              <h3>Branch Merged!</h3>
            </div>
            <div className="post-merge-body">
              <p>
                Would you like to switch to <strong>{postMergeInfo.baseBranch}</strong> and delete
                the <strong>{postMergeInfo.branchName}</strong> branch?
              </p>
            </div>
            <div className="post-merge-footer">
              <button
                className="post-merge-btn secondary"
                onClick={() => setPostMergeInfo(null)}
                disabled={isCleaningUp}
              >
                No, thanks
              </button>
              <button
                className="post-merge-btn primary"
                onClick={() => void handlePostMergeCleanup()}
                disabled={isCleaningUp}
              >
                {isCleaningUp ? 'Cleaning up...' : 'Yes, clean up'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface PrCardProps {
  pr: PullRequestInfo;
  isOwn: boolean;
  isMerging: boolean;
  onMerge?: () => void;
  onResolveConflicts?: (headBranch: string, baseBranch: string) => void;
}

function PrCard({ pr, isOwn, isMerging, onMerge, onResolveConflicts }: PrCardProps) {
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 60) {
      return `${diffMins} minutes ago`;
    } else if (diffHours < 24) {
      return `${diffHours} hours ago`;
    } else if (diffDays === 1) {
      return 'yesterday';
    } else {
      return `${diffDays} days ago`;
    }
  };

  const hasConflicts = pr.mergeable === false;
  const canMerge = pr.state === 'OPEN' && pr.mergeable !== false;

  return (
    <div className="pr-card">
      <div className="pr-card-info">
        <div className="pr-card-header">
          <div className={`pr-card-status ${pr.state.toLowerCase()}`} />
          <div className="pr-card-title">{pr.title}</div>
        </div>

        <div className="pr-card-meta">
          <span className="pr-card-branches">
            <span className="pr-card-branch">{pr.headRef}</span>
            <span>→</span>
            <span className="pr-card-branch">{pr.baseRef}</span>
          </span>
          <span>
            {' · '}
            {pr.state === 'MERGED' ? 'Merged' : `Opened by ${isOwn ? 'you' : pr.author}`}
            {' · '}
            {formatDate(pr.createdAt)}
          </span>
        </div>

        {hasConflicts && pr.state === 'OPEN' && (
          <div className="pr-card-warning">
            <WarningIcon size={14} />
            Has conflicts
          </div>
        )}
      </div>

      {pr.state === 'OPEN' && (
        <div className="pr-card-actions">
          <button className="branch-card-action" onClick={() => void openUrl(pr.url)}>
            View on GitHub <ExternalLinkIcon size={10} />
          </button>
          {hasConflicts && onResolveConflicts ? (
            <button
              className="branch-card-action primary"
              onClick={() => onResolveConflicts(pr.headRef, pr.baseRef)}
            >
              Resolve
            </button>
          ) : (
            onMerge && (
              <button
                className={`branch-card-action ${canMerge ? 'primary' : ''}`}
                onClick={onMerge}
                disabled={isMerging || !canMerge}
              >
                {isMerging ? 'Merging...' : 'Merge'}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
