/**
 * The header Push dropdown.
 *
 * Commits any uncommitted changes and pushes the current branch to origin.
 * The trigger button always reads "Push" — standard git terminology — while
 * the dropdown body carries the main-branch context (pushing to main updates
 * the live site) vs feature-branch context (create a PR to go live).
 *
 * @module components/PublishBranchDropdown
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { ProjectGitHubStatus } from '../../lib/github';
import { publishBranch } from '../../lib/branches';
import { ChevronIcon, BranchIcon, SuccessIcon, ErrorIcon, PushIcon } from '@/components/icons';
import { Spinner } from '../primitives/Spinner';
import { useClickOutside } from '../../hooks/useClickOutside';
import { logger } from '../../lib/logger';
import { trackEvent, trackError } from '../../lib/analytics';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError, isRecognizedGitFailure } from '../../lib/errors';
import { Button } from '../primitives/Button';
import { MenuButton } from '../primitives/MenuButton';
import { TextButton } from '../primitives/TextButton';
import type { ChangedFile } from '../../lib/git';
import { ChangedFilesActions, ChangedFilesSection } from './ChangedFilesSection';
import { HostingSection } from '../hosting/HostingSection';

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
  /** Controlled open state used by the workspace header's exclusive menus. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Visually joins the trigger to the adjacent unsaved-changes segment. */
  grouped?: boolean;
  /** Changed-file review is part of this single source-control menu. */
  changedFiles?: ChangedFile[];
  onDiscardChanges?: () => void;
  /** Hide the native hosting section (compact mode has no room for it). */
  hideHosting?: boolean;
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
  open: controlledOpen,
  onOpenChange,
  grouped = false,
  changedFiles = [],
  onDiscardChanges,
  hideHosting = false,
  excludeClickOutsideSelector,
}: PublishBranchDropdownProps) {
  const { showToast } = useOptionalToast();
  const onToast = (message: string, type?: 'success' | 'error' | 'info') =>
    showToast(message, type);
  const [internalOpen, setInternalOpen] = useState(false);
  const [publishState, setPublishState] = useState<PublishState>({ status: 'idle' });
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // When the push landed, so the hosting section can tell "the provider hasn't
  // picked this up yet" apart from "it never will".
  const [pushedAt, setPushedAt] = useState<number | undefined>(undefined);

  const hasGitHubRepo =
    projectGithubStatus?.status === 'connected' && projectGithubStatus?.github_repo;
  const isMainBranch = currentBranch === 'main' || currentBranch === 'master';
  const isOpen = controlledOpen ?? internalOpen;

  const setOpen = useCallback(
    (open: boolean) => {
      if (controlledOpen === undefined) setInternalOpen(open);
      onOpenChange?.(open);
    },
    [controlledOpen, onOpenChange]
  );

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
      setOpen(true);
      onForceOpenHandled?.();
      // In trigger mode, the parent immediately sets forceOpen back to false.
      // Pre-set the ref so the true→false transition doesn't close the dropdown.
      prevForceOpenRef.current = false;
    } else if (prevForceOpen === true && forceOpen === false) {
      // Controlled mode: parent explicitly closed the dropdown
      setOpen(false);
    }
  }, [forceOpen, hasGitHubRepo, onForceOpenHandled, setOpen]);

  // Close dropdown when clicking outside
  const closeDropdown = useCallback(() => {
    setOpen(false);
    onModalClose?.();
  }, [onModalClose, setOpen]);
  const clickOutsideExclusions = excludeClickOutsideSelector
    ? `${excludeClickOutsideSelector}, .modal-frame-overlay, .cf-modal-overlay`
    : '.modal-frame-overlay, .cf-modal-overlay';
  useClickOutside(dropdownRef, closeDropdown, isOpen, clickOutsideExclusions);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, setOpen]);

  // Drop a stale `success` state when the dropdown closes by any path —
  // click-outside, toggle, controlled-mode close, etc. Without this, the
  // user dismissing the "Changes synced — Done" view without clicking
  // Done would see the same stale view next time they opened the
  // dropdown, even after making new changes. Resetting only `success`
  // (not `error` or `publishing`) keeps useful state around: errors
  // remain visible on reopen so the user can retry, and an in-flight
  // publish keeps reporting its progress.
  useEffect(() => {
    if (!isOpen && publishState.status === 'success') {
      setPublishState({ status: 'idle' });
    }
  }, [isOpen, publishState.status]);

  const handlePublish = async () => {
    logger.info('Starting publish', { branch: currentBranch, isMainBranch, projectPath });
    setIsPublishing(true);
    setPublishState({ status: 'publishing' });

    try {
      const result = await publishBranch(projectPath);

      // Check for specific error types — carry the deployment state (and URL,
      // when Vercel returned one) instead of a canned "failed" string.
      if (result.state === 'ERROR') {
        throw new Error(
          `Deployment reported state "${result.state}"${result.url ? ` — ${result.url}` : ''}`
        );
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
      onToast?.('Pushed to GitHub!', 'success');
      onStatusChange();
      setPushedAt(Date.now());
      setPublishState({ status: 'success' });
    } catch (e) {
      const message = formatCommandError(asCommandError(e));
      let errorType: 'push_rejected' | 'auth_error' | 'merge_conflict' | 'generic' = 'generic';

      if (message.includes('MERGE_CONFLICT')) {
        errorType = 'merge_conflict';
      } else if (message.includes('PUSH_REJECTED')) {
        errorType = 'push_rejected';
      } else if (message.includes('AUTH_ERROR')) {
        errorType = 'auth_error';
      }

      // push_rejected ("someone else pushed first") and merge_conflict are
      // fully anticipated states with dedicated recovery UI (GitErrorHandler +
      // the dropdown's own error panel) — the backend already classifies them
      // Expected (#617). Keep them out of the reporting channels: logger.error
      // and error toasts both auto-file bug reports (issue #643); mirror
      // handlePullLatest's warn/info treatment of the pull-side equivalents.
      //
      // The three tag substrings above are not the only Expected failures this
      // path sees: git_stage_and_commit's pre-commit-hook refusal (#604) — the
      // project's own husky/lint chain rejecting the commit — carries none of
      // them and so reported as a bug every time (issue #766). Ask the shared
      // recognizer, which knows the backend's humanized wordings.
      const expectedFailure =
        errorType === 'push_rejected' ||
        errorType === 'merge_conflict' ||
        isRecognizedGitFailure(e, { branch: currentBranch });
      if (expectedFailure) {
        logger.warn('Publish refused (expected state)', {
          branch: currentBranch,
          errorType,
          message,
        });
      } else {
        logger.error('Publish failed', { branch: currentBranch, errorType, message });
        trackError('git_push', e, 'Workspace');
      }
      setPublishState({ status: 'error', message, errorType });
      onToast?.(`Push failed: ${message}`, expectedFailure ? 'info' : 'error');

      // Notify parent about the error for GitErrorHandler
      if (onPublishError) {
        onPublishError(message, errorType);
      }
    } finally {
      setIsPublishing(false);
    }
  };

  const handleDone = () => {
    setOpen(false);
    setPublishState({ status: 'idle' });
    onModalClose?.();
  };

  // Still checking GitHub status - show loading state
  if (projectGithubStatus === null) {
    return (
      <div
        className={`publish-dropdown${grouped ? ' publish-dropdown--grouped' : ''}`}
        ref={dropdownRef}
      >
        <MenuButton
          ref={triggerRef}
          expanded={false}
          className="source-control-push-button"
          data-education-id="publish-button"
          disabled
          title="Checking GitHub status..."
        >
          <span className="source-control-push-content">
            <PushIcon size={16} />
            <span>Push</span>
          </span>
          <ChevronIcon />
        </MenuButton>
      </div>
    );
  }

  // If no GitHub repo, show disabled state
  if (!hasGitHubRepo) {
    return (
      <div
        className={`publish-dropdown${grouped ? ' publish-dropdown--grouped' : ''}`}
        ref={dropdownRef}
      >
        <MenuButton
          ref={triggerRef}
          expanded={false}
          className="source-control-push-button"
          data-education-id="publish-button"
          disabled
          title="Create a GitHub repository first"
        >
          <span className="source-control-push-content">
            <PushIcon size={16} />
            <span>Push</span>
          </span>
          <ChevronIcon />
        </MenuButton>
      </div>
    );
  }

  // Check if there are changes to sync
  const canSync = hasChangesToSync || isPublishing || publishState.status !== 'idle';

  return (
    <div
      className={`publish-dropdown${grouped ? ' publish-dropdown--grouped' : ''}`}
      ref={dropdownRef}
    >
      <MenuButton
        ref={triggerRef}
        expanded={isOpen}
        variant={canSync ? 'primary' : 'default'}
        className={`${isPublishing ? 'publishing ' : ''}source-control-push-button`}
        data-education-id="publish-button"
        onClick={() => setOpen(!isOpen)}
      >
        <span className="source-control-push-content">
          <PushIcon size={16} />
          <span>{isPublishing ? 'Pushing...' : 'Push'}</span>
        </span>
        <ChevronIcon size={16} />
      </MenuButton>

      {isOpen && (
        <div className="publish-dropdown-menu">
          {/* Success State */}
          {publishState.status === 'success' && (
            <>
              <div className="publish-success">
                <SuccessIcon />
                <span>Pushed!</span>
              </div>
              {!isMainBranch && (
                <div className="publish-branch-hint">
                  Your changes are on the <strong>{currentBranch}</strong> branch on GitHub.
                  {onCreatePR && (
                    <>
                      {' '}
                      When they are ready for review,{' '}
                      <TextButton
                        variant="primary"
                        onClick={() => {
                          handleDone();
                          onCreatePR();
                        }}
                      >
                        create a PR
                      </TextButton>
                      .
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {/* Error State */}
          {publishState.status === 'error' && (
            <>
              <div className="publish-error-header">
                <ErrorIcon />
                <span>Push failed</span>
              </div>
              <div className="publish-error-message">
                {publishState.errorType === 'push_rejected'
                  ? 'Push was rejected. Someone else pushed changes to this branch.'
                  : publishState.errorType === 'auth_error'
                    ? 'Authentication failed. Please check your GitHub connection.'
                    : publishState.message}
              </div>
            </>
          )}

          {/* Publishing State */}
          {publishState.status === 'publishing' && (
            <>
              <div className="publish-in-progress-header">
                <Spinner />
                <span>Pushing to GitHub...</span>
              </div>
            </>
          )}

          {/* Idle State - with changes to sync */}
          {publishState.status === 'idle' && canSync && (
            <>
              <div className="publish-branch-header">
                <h3>Push to GitHub</h3>
              </div>

              <div className="publish-branch-body">
                <div className="publish-branch-info">
                  <BranchIcon size={12} />
                  <span className="publish-branch-name">{currentBranch}</span>
                </div>

                <div className="publish-branch-description">
                  Commits your changes and pushes the <strong>{currentBranch}</strong> branch to
                  GitHub.
                </div>
              </div>

              <ChangedFilesSection changedFiles={changedFiles} projectPath={projectPath} />
            </>
          )}

          {/* Synced State */}
          {publishState.status === 'idle' && !canSync && (
            <>
              <div className="publish-success">
                <SuccessIcon />
                <span>Nothing to push — GitHub is up to date</span>
              </div>
            </>
          )}

          {!hideHosting && (
            <HostingSection projectPath={projectPath} open={isOpen} pushedAt={pushedAt} />
          )}

          {publishState.status === 'success' && (
            <div className="publish-actions publish-actions-center">
              <Button width="fill" onClick={handleDone}>
                Done
              </Button>
            </div>
          )}

          {publishState.status === 'error' && (
            <div className="publish-actions">
              <Button variant="secondary" onClick={handleDone}>
                Close
              </Button>
              <Button variant="primary" onClick={() => setPublishState({ status: 'idle' })}>
                Try Again
              </Button>
            </div>
          )}

          {publishState.status === 'publishing' && (
            <div className="publish-actions">
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
          )}

          {publishState.status === 'idle' && canSync && (
            <ChangedFilesActions
              projectPath={projectPath}
              onDiscard={onDiscardChanges}
              primaryAction={
                <Button
                  variant="primary"
                  onClick={() => void handlePublish()}
                  disabled={isPublishing}
                >
                  Push
                </Button>
              }
            />
          )}

          {publishState.status === 'idle' && !canSync && (
            <div className="publish-actions publish-actions-center">
              <Button width="fill" onClick={handleDone}>
                Done
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
