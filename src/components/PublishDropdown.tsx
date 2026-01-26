/**
 * PublishDropdown component for deploying changes to staging and production.
 *
 * Provides a dropdown menu that allows users to:
 * - Select deployment targets (staging, production, or both)
 * - View current branch sync status (commits ahead/behind)
 * - Publish changes by pushing to GitHub branches
 * - View deployment URLs and open Vercel dashboard
 * - Reset local changes to match a deployed branch
 *
 * Works in conjunction with Vercel's GitHub integration - pushing to
 * the staging or main branch triggers automatic Vercel deployments.
 *
 * States: idle -> publishing -> success/error
 *
 * @module components/PublishDropdown
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  ProjectGitHubStatus,
  BranchStatus,
  getBranchStatus,
  publishToStaging,
  publishToProduction,
  resetToBranch,
} from '../lib/github';
import { ProjectVercelStatus } from '../lib/vercel';
import {
  ChevronIcon,
  ExternalLinkIcon,
  SuccessIcon,
  ErrorIcon,
  SpinnerIcon,
  VercelIcon,
  CopyIcon,
  ResetIcon,
} from './icons';
import { useClickOutside } from '../hooks/useClickOutside';

interface PublishDropdownProps {
  projectGithubStatus: ProjectGitHubStatus | null;
  projectVercelStatus: ProjectVercelStatus | null;
  projectPath: string;
  onStatusChange: () => void;
  onModalClose?: () => void;
  onToast?: (message: string, type?: 'success' | 'error') => void;
  isPublishing: boolean;
  setIsPublishing: (publishing: boolean) => void;
}

type PublishState =
  | { status: 'idle' }
  | { status: 'publishing'; target: 'staging' | 'production' | 'both' }
  | { status: 'success'; target: 'staging' | 'production' | 'both' }
  | { status: 'error'; message: string };

export function PublishDropdown({
  projectGithubStatus,
  projectVercelStatus,
  projectPath,
  onStatusChange,
  onModalClose,
  onToast,
  isPublishing,
  setIsPublishing,
}: PublishDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [stagingChecked, setStagingChecked] = useState(true);
  const [productionChecked, setProductionChecked] = useState(false);
  const [publishState, setPublishState] = useState<PublishState>({ status: 'idle' });
  const [branchStatus, setBranchStatus] = useState<BranchStatus | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState<'staging' | 'production' | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const hasGitHubRepo =
    projectGithubStatus?.status === 'connected' && projectGithubStatus?.github_repo;
  const hasVercel = projectVercelStatus?.status === 'connected';

  // Fetch branch status when dropdown opens
  const fetchBranchStatus = useCallback(async () => {
    if (!projectPath || !hasGitHubRepo) return;
    try {
      const status = await getBranchStatus(projectPath);
      setBranchStatus(status);
    } catch (e) {
      console.warn('Failed to get branch status:', e);
    }
  }, [projectPath, hasGitHubRepo]);

  // Reset state when project changes
  useEffect(() => {
    setPublishState({ status: 'idle' });
    setBranchStatus(null);
    setIsOpen(false);
  }, [projectPath]);

  // Fetch status when dropdown opens
  useEffect(() => {
    if (isOpen && hasGitHubRepo) {
      void fetchBranchStatus();
    }
  }, [isOpen, hasGitHubRepo, fetchBranchStatus]);

  // Close dropdown when clicking outside
  const closeDropdown = useCallback(() => {
    setIsOpen(false);
    onModalClose?.();
  }, [onModalClose]);
  useClickOutside(dropdownRef, closeDropdown, isOpen);

  const handlePublish = async () => {
    if (!stagingChecked && !productionChecked) return;

    const target =
      stagingChecked && productionChecked ? 'both' : stagingChecked ? 'staging' : 'production';

    setIsPublishing(true);
    setPublishState({ status: 'publishing', target });

    try {
      // Push to staging if selected
      if (stagingChecked) {
        const result = await publishToStaging(projectPath);
        if (result.state === 'ERROR') {
          throw new Error('Failed to push to staging branch');
        }
      }

      // Push to production if selected
      if (productionChecked) {
        const result = await publishToProduction(projectPath);
        if (result.state === 'ERROR') {
          throw new Error('Failed to push to main branch');
        }
      }

      // Give Vercel a moment to register the deployment before showing success
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Success!
      setPublishState({ status: 'success', target });
      onToast?.(
        target === 'both' ? 'Pushed to staging and production!' : `Pushed to ${target}!`,
        'success'
      );

      // Refresh branch status and project status
      await fetchBranchStatus();
      onStatusChange();

      // Poll for URL updates (Vercel takes time to register deployments)
      const pollForUrls = async () => {
        for (let i = 0; i < 10; i++) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          onStatusChange();
        }
      };
      void pollForUrls();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setPublishState({ status: 'error', message });
      onToast?.('Push failed', 'error');
    } finally {
      setIsPublishing(false);
    }
  };

  const handleTryAgain = () => {
    setPublishState({ status: 'idle' });
  };

  const handleReset = async (branch: 'staging' | 'production') => {
    setIsResetting(true);
    try {
      await resetToBranch(projectPath, branch);
      onToast?.(`Reset to ${branch}`, 'success');
      setShowResetConfirm(null);
      await fetchBranchStatus();
      onStatusChange();
    } catch (e) {
      onToast?.(`Failed to reset: ${String(e)}`, 'error');
    } finally {
      setIsResetting(false);
    }
  };

  // Vercel URLs - fetched from `vercel alias ls` for real URLs including custom domains
  const vercelOrg = projectVercelStatus?.vercel_org;
  const vercelProjectName = projectVercelStatus?.project_name;
  const vercelDashboardUrl =
    vercelOrg && vercelProjectName
      ? `https://vercel.com/${vercelOrg}/${vercelProjectName}/deployments`
      : null;
  const stagingUrl = projectVercelStatus?.staging_url
    ? `https://${projectVercelStatus.staging_url}`
    : null;
  const productionUrl = projectVercelStatus?.production_url
    ? `https://${projectVercelStatus.production_url}`
    : null;

  // Determine if there are changes to push
  const hasChanges =
    branchStatus?.local_changes ||
    (branchStatus?.staging_ahead ?? 0) > 0 ||
    (branchStatus?.main_ahead ?? 0) > 0;

  // If no GitHub repo, show disabled state
  if (!hasGitHubRepo) {
    return (
      <div className="publish-dropdown" ref={dropdownRef}>
        <button
          className="publish-button publish-disabled"
          disabled
          title="Create a GitHub repository first"
        >
          Publish
          <ChevronIcon />
        </button>
      </div>
    );
  }

  return (
    <div className="publish-dropdown" ref={dropdownRef}>
      <button
        className={`publish-button ${isPublishing ? 'publishing' : ''} ${!hasChanges && !isOpen ? 'no-changes' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        {isPublishing ? 'Publishing...' : 'Publish'}
        <ChevronIcon />
      </button>

      {isOpen && (
        <div className="publish-dropdown-menu">
          {/* Success State */}
          {publishState.status === 'success' && (
            <>
              <div className="publish-success">
                <SuccessIcon />
                <span>
                  Pushed to{' '}
                  {publishState.target === 'both' ? 'staging & production' : publishState.target}
                </span>
              </div>
              {hasVercel && (
                <div className="publish-success-message">
                  Vercel is deploying your changes.
                  <br />
                  This usually takes 1-2 minutes.
                </div>
              )}
              {hasVercel && vercelDashboardUrl && (
                <div className="publish-success-vercel">
                  <button
                    className="publish-vercel-button"
                    onClick={() => void openUrl(vercelDashboardUrl)}
                  >
                    <VercelIcon />
                    View Deployments
                    <ExternalLinkIcon />
                  </button>
                </div>
              )}
              <div className="publish-success-sites">
                {(publishState.target === 'staging' || publishState.target === 'both') &&
                  (stagingUrl ? (
                    <button
                      className="publish-link-button"
                      onClick={() => {
                        void navigator.clipboard.writeText(stagingUrl);
                        onToast?.('Staging URL copied', 'success');
                      }}
                    >
                      <CopyIcon />
                      Copy Staging URL
                    </button>
                  ) : (
                    <button className="publish-link-button publish-link-loading" disabled>
                      <SmallSpinnerIcon />
                      Loading Staging URL...
                    </button>
                  ))}
                {(publishState.target === 'production' || publishState.target === 'both') &&
                  (productionUrl ? (
                    <button
                      className="publish-link-button"
                      onClick={() => {
                        void navigator.clipboard.writeText(productionUrl);
                        onToast?.('Production URL copied', 'success');
                      }}
                    >
                      <CopyIcon />
                      Copy Production URL
                    </button>
                  ) : (
                    <button className="publish-link-button publish-link-loading" disabled>
                      <SmallSpinnerIcon />
                      Loading Production URL...
                    </button>
                  ))}
              </div>
              <div className="publish-actions publish-actions-center">
                <button
                  className="publish-done"
                  onClick={() => {
                    setIsOpen(false);
                    setPublishState({ status: 'idle' });
                    onModalClose?.();
                  }}
                >
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
                <span>Failed to publish</span>
              </div>
              <div className="publish-error-message">{publishState.message}</div>
              <div className="publish-actions">
                <button
                  className="publish-close"
                  onClick={() => {
                    setIsOpen(false);
                    setPublishState({ status: 'idle' });
                    onModalClose?.();
                  }}
                >
                  Close
                </button>
                <button className="publish-submit" onClick={handleTryAgain}>
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
                <span>
                  Publishing to{' '}
                  {publishState.target === 'both' ? 'staging & production' : publishState.target}...
                </span>
              </div>
              <div className="publish-actions">
                <button
                  className="publish-close"
                  onClick={() => {
                    setIsOpen(false);
                    onModalClose?.();
                  }}
                >
                  Close
                </button>
              </div>
            </>
          )}

          {/* Idle State - Loading */}
          {publishState.status === 'idle' && !branchStatus && (
            <div className="publish-loading">
              <div className="publish-loading-spinner" />
              <span>Loading...</span>
            </div>
          )}

          {/* Idle State - Selection UI */}
          {publishState.status === 'idle' &&
            branchStatus &&
            (() => {
              // Determine if there are changes to push for each target
              // Include local_changes because publish auto-commits before pushing
              const hasLocalChanges = branchStatus?.local_changes ?? false;
              const canPushToStaging =
                !branchStatus.staging_exists || branchStatus.staging_ahead > 0 || hasLocalChanges;
              const canPushToProduction = branchStatus.main_ahead > 0 || hasLocalChanges;

              // Can only publish if selected targets have changes
              const wouldPublishSomething =
                (stagingChecked && canPushToStaging) || (productionChecked && canPushToProduction);

              return (
                <>
                  {/* Staging Row */}
                  <label
                    className={`publish-row ${!canPushToStaging ? 'publish-row-disabled' : ''}`}
                  >
                    <div className="publish-row-left">
                      <input
                        type="checkbox"
                        checked={stagingChecked}
                        onChange={(e) => setStagingChecked(e.target.checked)}
                        disabled={isPublishing || !canPushToStaging}
                      />
                      <span className="publish-row-label">Staging</span>
                      {branchStatus &&
                        (() => {
                          // Count uncommitted changes as +1 (will become 1 commit when published)
                          const pendingCount =
                            branchStatus.staging_ahead + (hasLocalChanges ? 1 : 0);
                          if (!branchStatus.staging_exists) {
                            return <span className="publish-row-badge">new</span>;
                          } else if (pendingCount > 0) {
                            return <span className="publish-row-badge">{pendingCount} ahead</span>;
                          } else {
                            return (
                              <span className="publish-row-badge publish-row-badge-synced">
                                up to date
                              </span>
                            );
                          }
                        })()}
                    </div>
                    {hasVercel && stagingUrl && (
                      <button
                        className="publish-row-link"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void openUrl(stagingUrl);
                        }}
                        title="Open staging site"
                      >
                        <ExternalLinkIcon />
                      </button>
                    )}
                  </label>

                  {/* Production Row */}
                  <label
                    className={`publish-row ${!canPushToProduction ? 'publish-row-disabled' : ''}`}
                  >
                    <div className="publish-row-left">
                      <input
                        type="checkbox"
                        checked={productionChecked}
                        onChange={(e) => setProductionChecked(e.target.checked)}
                        disabled={isPublishing || !canPushToProduction}
                      />
                      <span className="publish-row-label">Production</span>
                      {branchStatus &&
                        (() => {
                          // Count uncommitted changes as +1 (will become 1 commit when published)
                          const pendingCount = branchStatus.main_ahead + (hasLocalChanges ? 1 : 0);
                          if (pendingCount > 0) {
                            return <span className="publish-row-badge">{pendingCount} ahead</span>;
                          } else {
                            return (
                              <span className="publish-row-badge publish-row-badge-synced">
                                up to date
                              </span>
                            );
                          }
                        })()}
                    </div>
                    {hasVercel && productionUrl && (
                      <button
                        className="publish-row-link"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void openUrl(productionUrl);
                        }}
                        title="Open production site"
                      >
                        <ExternalLinkIcon />
                      </button>
                    )}
                  </label>

                  {/* Actions */}
                  <div className="publish-actions">
                    {hasVercel && vercelDashboardUrl && (
                      <button
                        className="publish-deployments-link"
                        onClick={() => void openUrl(vercelDashboardUrl)}
                      >
                        Deployments
                        <ExternalLinkIcon />
                      </button>
                    )}
                    <div className="publish-actions-right">
                      <button
                        className="publish-submit"
                        onClick={() => void handlePublish()}
                        disabled={isPublishing || !wouldPublishSomething}
                      >
                        Publish
                      </button>
                    </div>
                  </div>

                  {/* Reset Option - show when there are local changes */}
                  {hasLocalChanges && (
                    <div className="publish-reset-section">
                      <button
                        className="publish-reset-link"
                        onClick={() =>
                          setShowResetConfirm(
                            branchStatus.staging_exists ? 'staging' : 'production'
                          )
                        }
                      >
                        <ResetIcon />
                        Reset local changes
                      </button>
                    </div>
                  )}

                  {/* Reset Confirmation */}
                  {showResetConfirm && (
                    <div className="publish-reset-confirm">
                      <p>Reset to which version?</p>
                      <div className="publish-reset-options">
                        {branchStatus.staging_exists && (
                          <button
                            onClick={() => void handleReset('staging')}
                            disabled={isResetting}
                          >
                            {isResetting ? 'Resetting...' : 'Staging'}
                          </button>
                        )}
                        <button
                          onClick={() => void handleReset('production')}
                          disabled={isResetting}
                        >
                          {isResetting ? 'Resetting...' : 'Production'}
                        </button>
                        <button
                          className="publish-reset-cancel"
                          onClick={() => setShowResetConfirm(null)}
                          disabled={isResetting}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
        </div>
      )}
    </div>
  );
}

function SmallSpinnerIcon() {
  return <SpinnerIcon size={12} />;
}
