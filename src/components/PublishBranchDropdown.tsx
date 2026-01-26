/**
 * Simplified publish dropdown for branch-based workflow.
 *
 * Publishes the current branch to origin. Shows different messaging
 * for main branch (production) vs feature branches.
 *
 * @module components/PublishBranchDropdown
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ProjectGitHubStatus } from "../lib/github";
import { ProjectVercelStatus } from "../lib/vercel";
import { publishBranch, getDeploymentStatus } from "../lib/branches";
import {
  ChevronIcon,
  BranchIcon,
  ExternalLinkIcon,
  SuccessIcon,
  ErrorIcon,
  SpinnerIcon,
  VercelIcon,
} from "./icons";
import { useClickOutside } from "../hooks/useClickOutside";
import { logger } from "../lib/logger";
import { ExponentialPoller } from "../lib/polling";

interface PublishBranchDropdownProps {
  /** Current branch name */
  currentBranch: string;
  /** Project's GitHub connection status */
  projectGithubStatus: ProjectGitHubStatus | null;
  /** Project's Vercel connection status */
  projectVercelStatus: ProjectVercelStatus | null;
  /** Absolute path to the project */
  projectPath: string;
  /** Whether there are uncommitted changes or unpushed commits */
  hasChangesToSync: boolean;
  /** Callback when publish completes successfully */
  onStatusChange: () => void;
  /** Callback when modal closes */
  onModalClose?: () => void;
  /** Callback for toast notifications */
  onToast?: (message: string, type?: "success" | "error") => void;
  /** Publishing state (lifted from parent) */
  isPublishing: boolean;
  /** Set publishing state */
  setIsPublishing: (publishing: boolean) => void;
  /** Callback when a publish error occurs */
  onPublishError?: (error: string, errorType: "push_rejected" | "auth_error" | "merge_conflict" | "generic") => void;
}

type PublishState =
  | { status: "idle" }
  | { status: "publishing" }
  | { status: "deploying"; startTime: number }
  | { status: "deployed"; url: string | null; duration: number }
  | { status: "deploy_error"; duration: number }
  | { status: "success" }
  | { status: "error"; message: string; errorType?: "push_rejected" | "auth_error" | "merge_conflict" | "generic" };

export function PublishBranchDropdown({
  currentBranch,
  projectGithubStatus,
  projectVercelStatus,
  projectPath,
  hasChangesToSync,
  onStatusChange,
  onModalClose,
  onToast,
  isPublishing,
  setIsPublishing,
  onPublishError,
}: PublishBranchDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [publishState, setPublishState] = useState<PublishState>({ status: "idle" });
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasShownToastRef = useRef(false);

  const hasGitHubRepo = projectGithubStatus?.status === "connected" && projectGithubStatus?.github_repo;
  const hasVercel = projectVercelStatus?.status === "connected";
  const isMainBranch = currentBranch === "main" || currentBranch === "master";

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // Poll deployment status when in deploying state (with exponential backoff)
  useEffect(() => {
    if (publishState.status !== "deploying" || !hasVercel) return;

    const startTime = publishState.startTime;
    logger.info("Starting deployment polling", { projectPath, startTime });

    // Update elapsed time every second
    timerRef.current = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    // Create poller with exponential backoff
    const poller = new ExponentialPoller(
      async () => {
        // Timeout after 5 minutes - give up and show success without URL
        const elapsed = Date.now() - startTime;
        if (elapsed > 5 * 60 * 1000) {
          logger.warn("Deployment polling timeout", { elapsed });
          throw new Error("TIMEOUT");
        }

        // Pass startTime to filter out deployments created before our push
        const status = await getDeploymentStatus(projectPath, startTime);
        return status;
      },
      (result) => {
        if (result.error) {
          if (result.error.message === "TIMEOUT") {
            const duration = Math.floor((Date.now() - startTime) / 1000);
            setPublishState({ status: "deployed", url: null, duration });
            poller.stop();
            if (timerRef.current) clearInterval(timerRef.current);
          }
          // Other errors - continue polling with backoff
          return;
        }

        const status = result.data;
        logger.debug("Deployment status poll", { status, attempt: result.attempt });

        if (status) {
          // Only treat as READY if we have a URL (confirms it's the new deployment)
          if (status.state === "READY" && status.url) {
            logger.info("Deployment ready", { url: status.url });
            const duration = Math.floor((Date.now() - startTime) / 1000);
            setPublishState({ status: "deployed", url: status.url, duration });
            poller.stop();
            if (timerRef.current) clearInterval(timerRef.current);
            // Prevent duplicate toasts from race condition
            if (!hasShownToastRef.current) {
              hasShownToastRef.current = true;
              onToast?.(`Deployed in ${duration}s`, "success");
            }
          } else if (status.state === "ERROR" || status.state === "CANCELED") {
            logger.error("Deployment failed", { state: status.state });
            const duration = Math.floor((Date.now() - startTime) / 1000);
            setPublishState({ status: "deploy_error", duration });
            poller.stop();
            if (timerRef.current) clearInterval(timerRef.current);
            // Prevent duplicate toasts from race condition
            if (!hasShownToastRef.current) {
              hasShownToastRef.current = true;
              onToast?.("Deployment failed", "error");
            }
          }
        }
      },
      {
        initialInterval: 2000,   // Start checking every 2s
        maxInterval: 15000,      // Back off to 15s max
        multiplier: 1.5,         // Gradual backoff
        jitter: true,            // Prevent thundering herd
        name: "deployment-status",
      }
    );

    // Store reference for cleanup
    pollingRef.current = { clear: () => poller.stop() } as unknown as ReturnType<typeof setInterval>;
    poller.start();

    return () => {
      poller.stop();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [publishState, hasVercel, projectPath, onToast]);

  // Close dropdown when clicking outside
  const closeDropdown = useCallback(() => {
    setIsOpen(false);
    onModalClose?.();
  }, [onModalClose]);
  useClickOutside(dropdownRef, closeDropdown, isOpen);

  // Generate preview URL for branch
  const getPreviewUrl = (): string | null => {
    if (!hasVercel || !projectVercelStatus?.production_url) {
      return null;
    }
    if (isMainBranch) {
      return `https://${projectVercelStatus.production_url}`;
    }
    // For feature branches, Vercel creates preview URLs
    // Format: project-branch-name.vercel.app
    const projectName = projectVercelStatus.project_name || projectGithubStatus?.github_repo?.split("/")[1];
    if (projectName) {
      const branchSlug = currentBranch.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
      return `https://${projectName}-git-${branchSlug}.vercel.app`;
    }
    return null;
  };

  const handlePublish = async () => {
    logger.info("Starting publish", { branch: currentBranch, isMainBranch, projectPath });
    setIsPublishing(true);
    setPublishState({ status: "publishing" });

    try {
      const result = await publishBranch(projectPath);

      // Check for specific error types
      if (result.state === "ERROR") {
        throw new Error("Failed to publish branch");
      }

      logger.info("Publish succeeded", { branch: currentBranch });
      onToast?.(
        isMainBranch ? "Pushed to GitHub!" : "Changes synced to GitHub!",
        "success"
      );
      onStatusChange();

      // If Vercel is connected, start tracking deployment
      if (hasVercel) {
        logger.debug("Starting Vercel deployment tracking");
        // Give Vercel a moment to register the deployment
        await new Promise(resolve => setTimeout(resolve, 2000));
        setElapsedSeconds(0);
        hasShownToastRef.current = false; // Reset for new deployment
        setPublishState({ status: "deploying", startTime: Date.now() });
      } else {
        setPublishState({ status: "success" });
      }

    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      let errorType: "push_rejected" | "auth_error" | "merge_conflict" | "generic" = "generic";

      if (message.includes("MERGE_CONFLICT")) {
        errorType = "merge_conflict";
      } else if (message.includes("PUSH_REJECTED")) {
        errorType = "push_rejected";
      } else if (message.includes("AUTH_ERROR")) {
        errorType = "auth_error";
      }

      logger.error("Publish failed", { branch: currentBranch, errorType, message });
      setPublishState({ status: "error", message, errorType });
      onToast?.(isMainBranch ? "Publish failed" : "Sync failed", "error");

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
    setPublishState({ status: "idle" });
    onModalClose?.();
  };

  // Vercel URLs
  const vercelOrg = projectVercelStatus?.vercel_org;
  const vercelProjectName = projectVercelStatus?.project_name;
  const vercelDashboardUrl = vercelOrg && vercelProjectName
    ? `https://vercel.com/${vercelOrg}/${vercelProjectName}/deployments`
    : null;
  const previewUrl = getPreviewUrl();

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

  // Disable sync button when there are no changes to sync
  const canSync = hasChangesToSync || isPublishing || publishState.status !== "idle";

  return (
    <div className="publish-dropdown" ref={dropdownRef}>
      <button
        className={`publish-button ${isPublishing ? "publishing" : ""} ${!canSync ? "synced" : ""}`}
        onClick={() => canSync && setIsOpen(!isOpen)}
        disabled={!canSync}
        title={!canSync ? "Already synced" : undefined}
      >
        {isPublishing
          ? (isMainBranch ? "Publishing..." : "Syncing...")
          : !canSync
          ? "Synced"
          : (isMainBranch ? "Publish" : "Sync")}
        <ChevronIcon />
      </button>

      {isOpen && (
        <div className="publish-dropdown-menu">
          {/* Deploying State - Vercel build in progress */}
          {publishState.status === "deploying" && (
            <>
              <div className="publish-deploying">
                <SpinnerIcon />
                <span>Deploying to Vercel...</span>
                <span className="publish-elapsed">{elapsedSeconds}s</span>
              </div>
              <div className="publish-deploying-message">
                Your changes were pushed to GitHub.<br />
                Waiting for Vercel build to complete.
              </div>
              <div className="publish-actions publish-actions-center">
                <button className="publish-done" onClick={handleDone}>
                  Close
                </button>
              </div>
            </>
          )}

          {/* Deployed State - Vercel build complete */}
          {publishState.status === "deployed" && (
            <>
              <div className="publish-success">
                <SuccessIcon />
                <span>Synced!</span>
                <span className="publish-elapsed">{publishState.duration}s</span>
              </div>
              <div className="publish-deployed-message">
                Your changes are live.{" "}
                {!isMainBranch && "Keep working, or create a pull request when ready."}
              </div>
              {publishState.url && (
                <div className="publish-deployed-url">
                  <span className="publish-url-text">
                    {publishState.url.replace("https://", "")}
                  </span>
                  <div className="publish-url-actions">
                    <button
                      className="publish-url-btn"
                      onClick={() => {
                        navigator.clipboard.writeText(publishState.url!);
                        onToast?.("URL copied", "success");
                      }}
                      title="Copy URL"
                    >
                      Copy
                    </button>
                    <button
                      className="publish-url-btn"
                      onClick={() => openUrl(publishState.url!)}
                      title="Open in browser"
                    >
                      Open
                    </button>
                  </div>
                </div>
              )}
              <div className="publish-actions publish-actions-center">
                <button className="publish-done" onClick={handleDone}>
                  Done
                </button>
              </div>
            </>
          )}

          {/* Deploy Error State */}
          {publishState.status === "deploy_error" && (
            <>
              <div className="publish-error-header">
                <ErrorIcon />
                <span>Deployment failed</span>
                <span className="publish-elapsed">{publishState.duration}s</span>
              </div>
              <div className="publish-error-message">
                The Vercel build failed. Check the Vercel dashboard for details.
              </div>
              {vercelDashboardUrl && (
                <div className="publish-success-vercel">
                  <button
                    className="publish-vercel-button"
                    onClick={() => openUrl(vercelDashboardUrl)}
                  >
                    <VercelIcon />
                    View Build Logs
                    <ExternalLinkIcon />
                  </button>
                </div>
              )}
              <div className="publish-actions publish-actions-center">
                <button className="publish-done" onClick={handleDone}>
                  Done
                </button>
              </div>
            </>
          )}

          {/* Success State (no Vercel) */}
          {publishState.status === "success" && (
            <>
              <div className="publish-success">
                <SuccessIcon />
                <span>
                  {isMainBranch ? "Published to production" : "Changes synced"}
                </span>
              </div>
              <div className="publish-actions publish-actions-center">
                <button className="publish-done" onClick={handleDone}>
                  Done
                </button>
              </div>
            </>
          )}

          {/* Error State */}
          {publishState.status === "error" && (
            <>
              <div className="publish-error-header">
                <ErrorIcon />
                <span>{isMainBranch ? "Failed to publish" : "Failed to sync"}</span>
              </div>
              <div className="publish-error-message">
                {publishState.errorType === "push_rejected"
                  ? "Push was rejected. Someone else pushed changes to this branch."
                  : publishState.errorType === "auth_error"
                    ? "Authentication failed. Please check your GitHub connection."
                    : publishState.message}
              </div>
              <div className="publish-actions">
                <button className="publish-close" onClick={handleDone}>
                  Close
                </button>
                <button
                  className="publish-submit"
                  onClick={() => setPublishState({ status: "idle" })}
                >
                  Try Again
                </button>
              </div>
            </>
          )}

          {/* Publishing State */}
          {publishState.status === "publishing" && (
            <>
              <div className="publish-in-progress-header">
                <SpinnerIcon />
                <span>
                  {isMainBranch ? "Publishing to production..." : "Syncing changes..."}
                </span>
              </div>
              <div className="publish-actions">
                <button className="publish-close" onClick={() => setIsOpen(false)}>
                  Close
                </button>
              </div>
            </>
          )}

          {/* Idle State */}
          {publishState.status === "idle" && (
            <>
              <div className="publish-branch-header">
                <h3>{isMainBranch ? "Publish to Production" : "Sync your changes"}</h3>
              </div>

              <div className="publish-branch-body">
                <div className="publish-branch-info">
                  <BranchIcon size={14} />
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

                {hasVercel && previewUrl && !isMainBranch && (
                  <div className="publish-branch-url">
                    <div className="publish-branch-url-label">Preview URL:</div>
                    <div className="publish-branch-url-value">{previewUrl.replace("https://", "")}</div>
                  </div>
                )}
              </div>

              <div className="publish-actions">
                <button className="publish-close" onClick={handleDone}>
                  Cancel
                </button>
                <button
                  className="publish-submit"
                  onClick={handlePublish}
                  disabled={isPublishing}
                >
                  {isMainBranch ? "Go Live" : "Sync"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
