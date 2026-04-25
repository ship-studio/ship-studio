/**
 * Simplified publish dropdown for branch-based workflow.
 *
 * Publishes the current branch to origin. Shows different messaging
 * for main branch (production) vs feature branches.
 *
 * @module components/PublishBranchDropdown
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { ProjectGitHubStatus } from '../lib/github';
import { publishBranch } from '../lib/branches';
import { ChevronIcon, BranchIcon, SuccessIcon, ErrorIcon, SpinnerIcon } from './icons';
import { useClickOutside } from '../hooks/useClickOutside';
import { logger } from '../lib/logger';
import { trackEvent, trackError } from '../lib/analytics';
import { useOptionalToast } from '../contexts/ToastContext';

// Module-scoped so the metric spans dropdown re-mounts. Per-project would be
// better but cross-project publish cadence is also useful and far simpler.
let lastPublishAt: number | null = null;

interface PublishBranchDropdownProps {
  /** Current branch name */
  currentBranch: string;
  /** Project's GitHub connection status */
  projectGithubStatus: ProjectGitHubStatus | null;
  /** Absolute path to the project */
  projectPath: string;
  /** Whether there are uncommitted changes or unpushed commits */
  hasChangesToSync: boolean;
  /** Callback when publish completes successfully */
  onStatusChange: () => void;
  /** Callback when modal closes */
  onModalClose?: () => void;
  /** Publishing state (lifted from parent) */
  isPublishing: boolean;
  /** Set publishing state */
  setIsPublishing: (publishing: boolean) => void;
  /** Callback when a publish error occurs */
  onPublishError?: (
    error: string,
    errorType: 'push_rejected' | 'auth_error' | 'merge_conflict' | 'generic'
  ) => void;
  /** Callback to open the Create PR modal */
  onCreatePR?: () => void;
  /** Force the dropdown to open (controlled from parent) */
  forceOpen?: boolean;
  /** Callback when forceOpen has been handled */
  onForceOpenHandled?: () => void;
  /**
   * CSS selector for elements that should NOT trigger click-outside closing.
   * Used by compact mode to exclude its publish button from closing the dropdown.
   */
  excludeClickOutsideSelector?: string;
}

type PublishState =
  | { status: 'idle' }
  | { status: 'publishing' }
  | { status: 'success' }
  | {
      status: 'error';
      message: string;
      errorType?: 'push_rejected' | 'auth_error' | 'merge_conflict' | 'generic';
    };

export function PublishBranchDropdown({
  currentBranch,
  projectGithubStatus,
  projectPath,
  hasChangesToSync,
  onStatusChange,
  onModalClose,
  isPublishing,
  setIsPublishing,
  onPublishError,
  onCreatePR,
  forceOpen,
  onForceOpenHandled,
  excludeClickOutsideSelector,
}: PublishBranchDropdownProps) {
  const { showToast } = useOptionalToast();
  const onToast = (message: string, type?: 'success' | 'error') => showToast(message, type);
  const [isOpen, setIsOpen] = useState(false);
  const [publishState, setPublishState] = useState<PublishState>({ status: 'idle' });
  const dropdownRef = useRef<HTMLDivElement>(null);

  const hasGitHubRepo =
    projectGithubStatus?.status === 'connected' && projectGithubStatus?.github_repo;
  const isMainBranch = currentBranch === 'main' || currentBranch === 'master';

  // Track previous forceOpen value to detect true→false transitions
  const prevForceOpenRef = useRef<boolean | undefined>(undefined);

  // Handle forceOpen prop from parent. Supports two modes:
  // 1. Trigger mode (header button): forceOpen briefly true, then reset via onForceOpenHandled
  // 2. Controlled mode (compact button): forceOpen stays synced with parent state
  // We only close on true→false transition to support controlled mode without breaking trigger mode
  useEffect(() => {
    const prevForceOpen = prevForceOpenRef.current;
    prevForceOpenRef.current = forceOpen;

    if (forceOpen && hasGitHubRepo) {
      setIsOpen(true);
      onForceOpenHandled?.();
      // In trigger mode, the parent immediately sets forceOpen back to false.
      // Pre-set the ref so the true→false transition doesn't close the dropdown.
      prevForceOpenRef.current = false;
    } else if (prevForceOpen === true && forceOpen === false) {
      // Controlled mode: parent explicitly closed the dropdown
      setIsOpen(false);
    }
  }, [forceOpen, hasGitHubRepo, onForceOpenHandled]);

  // Close dropdown when clicking outside
  const closeDropdown = useCallback(() => {
    setIsOpen(false);
    onModalClose?.();
  }, [onModalClose]);
  useClickOutside(dropdownRef, closeDropdown, isOpen, excludeClickOutsideSelector);

  const handlePublish = async () => {
    logger.info('Starting publish', { branch: currentBranch, isMainBranch, projectPath });
    setIsPublishing(true);
    setPublishState({ status: 'publishing' });

    try {
      const result = await publishBranch(projectPath);

      // Check for specific error types
      if (result.state === 'ERROR') {
        throw new Error('Failed to publish branch');
      }

      logger.info('Publish succeeded', { branch: currentBranch });
      const now = Date.now();
      // Don't ship the branch name — `feature/client-acme-flow` style names
      // routinely contain customer/codename data that doesn't belong in
      // PostHog. `is_main` carries the question we actually wanted to ask.
      void trackEvent('branch_published', {
        is_main: isMainBranch,
        time_since_last_publish_seconds:
          lastPublishAt !== null ? Math.round((now - lastPublishAt) / 1000) : null,
        $screen_name: 'Workspace',
      });
      lastPublishAt = now;
      onToast?.(isMainBranch ? 'Pushed to GitHub!' : 'Changes synced to GitHub!', 'success');
      onStatusChange();
      setPublishState({ status: 'success' });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      let errorType: 'push_rejected' | 'auth_error' | 'merge_conflict' | 'generic' = 'generic';

      if (message.includes('MERGE_CONFLICT')) {
        errorType = 'merge_conflict';
      } else if (message.includes('PUSH_REJECTED')) {
        errorType = 'push_rejected';
      } else if (message.includes('AUTH_ERROR')) {
        errorType = 'auth_error';
      }

      logger.error('Publish failed', { branch: currentBranch, errorType, message });
      trackError('git_push', e, 'Workspace');
      setPublishState({ status: 'error', message, errorType });
      onToast?.(isMainBranch ? 'Publish failed' : 'Sync failed', 'error');

      // Notify parent about the error for GitErrorHandler
      if (onPublishError) {
        onPublishError(message, errorType);
      }
    } finally {
      setIsPublishing(false);
    }
  };

  const handleDone = () => {
    setIsOpen(false);
    setPublishState({ status: 'idle' });
    onModalClose?.();
  };

  // Still checking GitHub status - show loading state
  if (projectGithubStatus === null) {
    return (
      <div className="publish-dropdown" ref={dropdownRef}>
        <button
          className="publish-button publish-checking"
          data-education-id="publish-button"
          disabled
          title="Checking status..."
        >
          Checking...
          <ChevronIcon />
        </button>
      </div>
    );
  }

  // If no GitHub repo, show disabled state
  if (!hasGitHubRepo) {
    return (
      <div className="publish-dropdown" ref={dropdownRef}>
        <button
          className="publish-button publish-disabled"
          data-education-id="publish-button"
          disabled
          title="Create a GitHub repository first"
        >
          Publish
          <ChevronIcon />
        </button>
      </div>
    );
  }

  // Check if there are changes to sync
  const canSync = hasChangesToSync || isPublishing || publishState.status !== 'idle';

  return (
    <div className="publish-dropdown" ref={dropdownRef}>
      <button
        className={`publish-button ${isPublishing ? 'publishing' : ''} ${!canSync ? 'synced' : ''}`}
        data-education-id="publish-button"
        onClick={() => setIsOpen(!isOpen)}
      >
        {isPublishing
          ? isMainBranch
            ? 'Publishing...'
            : 'Syncing...'
          : !canSync
            ? 'Synced'
            : isMainBranch
              ? 'Publish'
              : 'Sync'}
        <ChevronIcon />
      </button>

      {isOpen && (
        <div className="publish-dropdown-menu">
          {/* Success State */}
          {publishState.status === 'success' && (
            <>
              <div className="publish-success">
                <SuccessIcon />
                <span>{isMainBranch ? 'Published!' : 'Changes synced'}</span>
              </div>
              {!isMainBranch && (
                <div className="publish-branch-hint">
                  This change has been synced to the <strong>{currentBranch}</strong> branch.
                  {onCreatePR && (
                    <>
                      {' '}
                      To make the changes live,{' '}
                      <button
                        className="publish-create-pr-link"
                        onClick={() => {
                          handleDone();
                          onCreatePR();
                        }}
                      >
                        create a PR
                      </button>
                      .
                    </>
                  )}
                </div>
              )}
              <div className="publish-actions publish-actions-center">
                <button className="publish-done" onClick={handleDone}>
                  Done
                </button>
              </div>
            </>
          )}

          {/* Error State */}
          {publishState.status === 'error' && (
            <>
              <div className="publish-error-header">
                <ErrorIcon />
                <span>{isMainBranch ? 'Failed to publish' : 'Failed to sync'}</span>
              </div>
              <div className="publish-error-message">
                {publishState.errorType === 'push_rejected'
                  ? 'Push was rejected. Someone else pushed changes to this branch.'
                  : publishState.errorType === 'auth_error'
                    ? 'Authentication failed. Please check your GitHub connection.'
                    : publishState.message}
              </div>
              <div className="publish-actions">
                <button className="publish-close" onClick={handleDone}>
                  Close
                </button>
                <button
                  className="publish-submit"
                  onClick={() => setPublishState({ status: 'idle' })}
                >
                  Try Again
                </button>
              </div>
            </>
          )}

          {/* Publishing State */}
          {publishState.status === 'publishing' && (
            <>
              <div className="publish-in-progress-header">
                <SpinnerIcon />
                <span>{isMainBranch ? 'Publishing to production...' : 'Syncing changes...'}</span>
              </div>
              <div className="publish-actions">
                <button className="publish-close" onClick={() => setIsOpen(false)}>
                  Close
                </button>
              </div>
            </>
          )}

          {/* Idle State - with changes to sync */}
          {publishState.status === 'idle' && canSync && (
            <>
              <div className="publish-branch-header">
                <h3>{isMainBranch ? 'Publish to Production' : 'Sync your changes'}</h3>
              </div>

              <div className="publish-branch-body">
                <div className="publish-branch-info">
                  <BranchIcon size={12} />
                  <span className="publish-branch-name">{currentBranch}</span>
                  {isMainBranch && <span className="branch-live-badge">Live</span>}
                </div>

                {isMainBranch && (
                  <div className="publish-branch-warning">
                    This will update your live site. Changes will be visible to everyone.
                  </div>
                )}

                {!isMainBranch && (
                  <div className="publish-branch-description">
                    This will save your work to GitHub so others can see it.
                  </div>
                )}
              </div>

              <div className="publish-actions">
                <button className="publish-close" onClick={handleDone}>
                  Cancel
                </button>
                <button
                  className="publish-submit"
                  onClick={() => void handlePublish()}
                  disabled={isPublishing}
                >
                  {isMainBranch ? 'Go Live' : 'Sync'}
                </button>
              </div>
            </>
          )}

          {/* Synced State */}
          {publishState.status === 'idle' && !canSync && (
            <>
              <div className="publish-success">
                <SuccessIcon />
                <span>All changes synced</span>
              </div>
              <div className="publish-actions publish-actions-center">
                <button className="publish-done" onClick={handleDone}>
                  Done
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
