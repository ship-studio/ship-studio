/**
 * Pull Requests tab for workspace.
 *
 * Shows open and recently merged pull requests.
 *
 * @module components/PullRequestsTab
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  PullRequestInfo,
  listPullRequests,
  mergePullRequest,
  checkoutPullRequest,
  closePullRequest,
  deleteBranch,
  switchBranch,
} from '../../lib/branches';
import { useAsyncState } from '../../hooks/useAsyncState';
import { GitHubIcon, WarningIcon, BranchIcon } from '../icons';
import { trackEvent, trackError } from '../../lib/analytics';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';

interface PullRequestsTabProps {
  /** Project path for PR operations */
  projectPath: string;
  /** GitHub username for highlighting own PRs */
  githubUsername: string | null;
  /** Current checked-out branch name */
  currentBranch?: string;
  /** Callback to refresh after merge */
  onRefresh: () => void;
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
  currentBranch,
  onRefresh,
  onBranchSwitch,
  onNavigateToBranches,
  onResolveConflicts,
}: PullRequestsTabProps) {
  const { showToast } = useOptionalToast();
  const onToast = (message: string, type?: 'success' | 'error') => showToast(message, type);

  const fetchPrsFn = useCallback(async (path: string) => {
    try {
      return await listPullRequests(path);
    } catch (e) {
      trackError('pr_list', e, 'Workspace');
      throw e;
    }
  }, []);
  const {
    data: pullRequestsData,
    isLoading,
    error: fetchError,
    execute: executeFetchPrs,
  } = useAsyncState<PullRequestInfo[], [string]>(fetchPrsFn, { initial: [] });
  const pullRequests = pullRequestsData ?? [];
  const error = fetchError ? fetchError.message : null;
  const fetchPullRequests = useCallback(
    () => executeFetchPrs(projectPath),
    [executeFetchPrs, projectPath]
  );

  const [mergingPr, setMergingPr] = useState<number | null>(null);
  const [checkingOutPr, setCheckingOutPr] = useState<number | null>(null);
  const [checkedOutHead, setCheckedOutHead] = useState<string | null>(null);
  const [closingPr, setClosingPr] = useState<number | null>(null);
  const [confirmClosePr, setConfirmClosePr] = useState<PullRequestInfo | null>(null);
  const [confirmCheckoutPr, setConfirmCheckoutPr] = useState<PullRequestInfo | null>(null);
  const [confirmMergePr, setConfirmMergePr] = useState<PullRequestInfo | null>(null);
  const [postMergeInfo, setPostMergeInfo] = useState<{
    branchName: string;
    baseBranch: string;
  } | null>(null);
  const [isCleaningUp, setIsCleaningUp] = useState(false);

  // Clear local checkout tracking when currentBranch has settled on the checked-out branch.
  // Use a ref to avoid clearing prematurely (currentBranch may briefly match then revert to
  // stale cached data before settling).
  const checkedOutHeadRef = useRef<string | null>(null);
  checkedOutHeadRef.current = checkedOutHead;
  useEffect(() => {
    if (checkedOutHead && currentBranch === checkedOutHead) {
      // Wait for currentBranch to stabilize before clearing
      const timer = setTimeout(() => {
        if (checkedOutHeadRef.current === checkedOutHead) {
          setCheckedOutHead(null);
        }
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [currentBranch, checkedOutHead]);

  // Fetch pull requests
  useEffect(() => {
    void fetchPullRequests();
  }, [fetchPullRequests]);

  const handleMerge = async (prNumber: number, headRef: string, baseRef: string) => {
    setMergingPr(prNumber);
    try {
      await mergePullRequest(projectPath, prNumber);
      void trackEvent('pr_merged', {
        head_ref: headRef,
        base_ref: baseRef,
        $screen_name: 'Workspace',
      });
      onToast?.('Pull request merged', 'success');
      await fetchPullRequests();
      onRefresh();
      // Show post-merge cleanup dialog
      setPostMergeInfo({ branchName: headRef, baseBranch: baseRef });
    } catch (e) {
      trackError('pr_merge', e, 'Workspace');
      onToast?.(`Failed to merge: ${formatCommandError(asCommandError(e))}`, 'error');
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
        void trackEvent('post_merge_cleanup', {
          deleted_branch: postMergeInfo.branchName,
          $screen_name: 'Workspace',
        });
        onToast?.(
          `Switched to ${postMergeInfo.baseBranch} and deleted ${postMergeInfo.branchName}`,
          'success'
        );
        onRefresh();
      } else {
        onToast?.(result.error || 'Failed to switch branch', 'error');
      }
    } catch (e) {
      trackError('pr_post_merge_cleanup', e, 'Workspace');
      onToast?.(`Cleanup failed: ${formatCommandError(asCommandError(e))}`, 'error');
    } finally {
      setIsCleaningUp(false);
      setPostMergeInfo(null);
    }
  };

  const handleCheckout = async (prNumber: number, headRef: string) => {
    setCheckingOutPr(prNumber);
    try {
      await checkoutPullRequest(projectPath, prNumber);
      setCheckedOutHead(headRef);
      onBranchSwitch?.(headRef);
      void trackEvent('pr_checked_out', { head_ref: headRef, $screen_name: 'Workspace' });
      onToast?.(`Checked out branch ${headRef}`, 'success');
    } catch (e) {
      trackError('pr_checkout', e, 'Workspace');
      onToast?.(`Failed to checkout: ${formatCommandError(asCommandError(e))}`, 'error');
    } finally {
      setCheckingOutPr(null);
    }
  };

  const handleClose = async (prNumber: number) => {
    setClosingPr(prNumber);
    try {
      await closePullRequest(projectPath, prNumber);
      void trackEvent('pr_closed', { $screen_name: 'Workspace' });
      onToast?.('Pull request closed', 'success');
      await fetchPullRequests();
      onRefresh();
    } catch (e) {
      trackError('pr_close', e, 'Workspace');
      onToast?.(`Failed to close PR: ${formatCommandError(asCommandError(e))}`, 'error');
    } finally {
      setClosingPr(null);
    }
  };

  // Group PRs by state
  const openPrs = pullRequests.filter((pr) => pr.state === 'OPEN');
  const mergedPrs = pullRequests.filter((pr) => pr.state === 'MERGED').slice(0, 5);

  if (isLoading) {
    return (
      <div className="prs-tab">
        <div className="prs-tab-loading">
          <Spinner size="lg" />
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
              isCheckedOut={currentBranch === pr.headRef || checkedOutHead === pr.headRef}
              isMerging={mergingPr === pr.number}
              isCheckingOut={checkingOutPr === pr.number}
              isClosing={closingPr === pr.number}
              onMerge={() => setConfirmMergePr(pr)}
              onCheckout={() => setConfirmCheckoutPr(pr)}
              onClose={() => setConfirmClosePr(pr)}
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

      {/* Merge PR confirmation modal */}
      {confirmMergePr && (
        <ModalFrame
          isOpen
          onClose={() => setConfirmMergePr(null)}
          dismissable={!mergingPr}
          title="Merge Pull Request?"
          className="post-merge-content"
        >
          <div className="post-merge-body">
            <p>
              This will merge <strong>{confirmMergePr.headRef}</strong> into{' '}
              <strong>{confirmMergePr.baseRef}</strong>. The changes will go live, but can be rolled
              back if needed.
            </p>
          </div>
          <div className="post-merge-footer">
            <Button
              variant="secondary"
              onClick={() => setConfirmMergePr(null)}
              disabled={!!mergingPr}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                void handleMerge(
                  confirmMergePr.number,
                  confirmMergePr.headRef,
                  confirmMergePr.baseRef
                ).then(() => setConfirmMergePr(null));
              }}
              disabled={!!mergingPr}
            >
              {mergingPr ? 'Merging...' : 'Merge'}
            </Button>
          </div>
        </ModalFrame>
      )}

      {/* Post-merge cleanup modal */}
      {postMergeInfo && (
        <ModalFrame
          isOpen
          onClose={() => setPostMergeInfo(null)}
          dismissable={!isCleaningUp}
          title="Branch Merged!"
          className="post-merge-content"
        >
          <div className="post-merge-body">
            <p>
              Would you like to switch to <strong>{postMergeInfo.baseBranch}</strong> and delete the{' '}
              <strong>{postMergeInfo.branchName}</strong> branch?
            </p>
          </div>
          <div className="post-merge-footer">
            <Button
              variant="secondary"
              onClick={() => setPostMergeInfo(null)}
              disabled={isCleaningUp}
            >
              No, thanks
            </Button>
            <Button
              variant="primary"
              onClick={() => void handlePostMergeCleanup()}
              disabled={isCleaningUp}
            >
              {isCleaningUp ? 'Cleaning up...' : 'Yes, clean up'}
            </Button>
          </div>
        </ModalFrame>
      )}

      {/* Close PR confirmation modal */}
      {confirmClosePr && (
        <ModalFrame
          isOpen
          onClose={() => setConfirmClosePr(null)}
          dismissable={!closingPr}
          title="Close Pull Request?"
          className="post-merge-content"
        >
          <div className="post-merge-body">
            <p>
              This will close{' '}
              <strong>
                #{confirmClosePr.number} {confirmClosePr.title}
              </strong>{' '}
              without merging. The <strong>{confirmClosePr.headRef}</strong> branch will still exist
              and no progress will be lost. You can reopen this PR later from GitHub.
            </p>
          </div>
          <div className="post-merge-footer">
            <Button
              variant="secondary"
              onClick={() => setConfirmClosePr(null)}
              disabled={!!closingPr}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                void handleClose(confirmClosePr.number).then(() => setConfirmClosePr(null));
              }}
              disabled={!!closingPr}
            >
              {closingPr ? 'Closing...' : 'Close PR'}
            </Button>
          </div>
        </ModalFrame>
      )}

      {/* Checkout PR confirmation modal */}
      {confirmCheckoutPr && (
        <ModalFrame
          isOpen
          onClose={() => setConfirmCheckoutPr(null)}
          dismissable={!checkingOutPr}
          title="Pull this branch?"
          className="post-merge-content"
        >
          <div className="post-merge-body">
            <p>
              This will switch your project to the <strong>{confirmCheckoutPr.headRef}</strong>{' '}
              branch and pull the latest changes from the pull request. Any uncommitted changes on
              your current branch will be stashed.
            </p>
          </div>
          <div className="post-merge-footer">
            <Button
              variant="secondary"
              onClick={() => setConfirmCheckoutPr(null)}
              disabled={!!checkingOutPr}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                void handleCheckout(confirmCheckoutPr.number, confirmCheckoutPr.headRef).then(() =>
                  setConfirmCheckoutPr(null)
                );
              }}
              disabled={!!checkingOutPr}
            >
              {checkingOutPr ? 'Pulling...' : 'Pull'}
            </Button>
          </div>
        </ModalFrame>
      )}
    </div>
  );
}

interface PrCardProps {
  pr: PullRequestInfo;
  isOwn: boolean;
  isCheckedOut?: boolean;
  isMerging: boolean;
  isCheckingOut?: boolean;
  isClosing?: boolean;
  onMerge?: () => void;
  onCheckout?: () => void;
  onClose?: () => void;
  onResolveConflicts?: (headBranch: string, baseBranch: string) => void;
}

function PrCard({
  pr,
  isOwn,
  isCheckedOut,
  isMerging,
  isCheckingOut,
  isClosing,
  onMerge,
  onCheckout,
  onClose,
  onResolveConflicts,
}: PrCardProps) {
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
    <div className={`pr-card${isCheckedOut ? ' pr-card-checked-out' : ''}`}>
      <div className="pr-card-info">
        <div className="pr-card-header">
          <div className={`pr-card-status ${pr.state.toLowerCase()}`} />
          <div className="pr-card-title">{pr.title}</div>
          <span className="pr-card-number">#{pr.number}</span>
          {isCheckedOut && <span className="pr-card-current-label">you are here</span>}
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
          <button
            className="branch-card-action pr-card-icon-btn"
            onClick={() => void openUrl(pr.url)}
            title="View on GitHub"
          >
            <GitHubIcon size={16} />
          </button>
          {onCheckout && !isCheckedOut && (
            <Button variant="secondary" size="sm" onClick={onCheckout} disabled={isCheckingOut}>
              {isCheckingOut ? 'Pulling...' : 'Pull'}
            </Button>
          )}
          {hasConflicts && onResolveConflicts ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => onResolveConflicts(pr.headRef, pr.baseRef)}
            >
              Resolve
            </Button>
          ) : (
            onMerge && (
              <Button
                variant={canMerge ? 'primary' : 'secondary'}
                size="sm"
                onClick={onMerge}
                disabled={isMerging || !canMerge}
              >
                {isMerging ? 'Merging...' : 'Merge'}
              </Button>
            )
          )}
          {onClose && (
            <Button variant="danger" size="sm" onClick={onClose} disabled={isClosing}>
              {isClosing ? 'Closing...' : 'Close'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
