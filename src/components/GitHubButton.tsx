/**
 * GitHubButton component for GitHub repository management.
 *
 * Provides a dropdown button that allows users to:
 * - Create a new GitHub repository for the project
 * - Push changes to an existing repository
 * - View repository status (remote URL, pending changes)
 * - Auto-connect to Vercel after repo creation
 *
 * Uses the GitHub CLI (gh) for all operations via Tauri backend.
 *
 * @module components/GitHubButton
 */

import { useState, useEffect, useRef } from 'react';
import { GitHubState, VercelState } from '../App';
import { ProjectGitHubStatus, pushToGitHub, getGitHubOrgs } from '../lib/github';
import { linkToVercel } from '../lib/vercel';
import { openUrl } from '@tauri-apps/plugin-opener';

/** Props for the GitHubButton component */
interface GitHubButtonProps {
  /** Global GitHub authentication state */
  githubState: GitHubState;
  /** Global Vercel authentication state (for auto-connect feature) */
  vercelState?: VercelState;
  /** Current project's GitHub status (remote, branch, pending changes) */
  projectStatus: ProjectGitHubStatus | null;
  /** Absolute path to the project directory */
  projectPath: string;
  /** Project name (used as default repo name) */
  projectName: string;
  /** Callback to refresh project status after changes */
  onStatusChange: (vercelDeployedUrl?: string) => Promise<void> | void;
  /** Callback to initiate GitHub CLI authentication */
  onGitHubConnect: () => void;
  /** Optional callback when modal is closed */
  onModalClose?: () => void;
  /** Optional callback to show toast notifications */
  onToast?: (message: string, type?: 'success' | 'error') => void;
  /** Optional callback when Vercel auto-connect starts */
  onVercelAutoConnectStart?: () => void;
  /** Optional callback when Vercel auto-connect completes */
  onVercelAutoConnectEnd?: () => void;
}

export function GitHubButton({
  githubState,
  vercelState,
  projectStatus,
  projectPath,
  projectName,
  onStatusChange,
  onGitHubConnect,
  onModalClose,
  onToast,
  onVercelAutoConnectStart,
  onVercelAutoConnectEnd,
}: GitHubButtonProps) {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [repoName, setRepoName] = useState(projectName);
  const [isPrivate, setIsPrivate] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreatingRepo, setIsCreatingRepo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<string[]>([]);
  const [selectedOwner, setSelectedOwner] = useState<string | null>(null);
  const authPollCancelledRef = useRef(false);
  const authPollRunningRef = useRef(false);

  const { cliStatus, username } = githubState;

  // Cancel auth polling on unmount or when auth succeeds
  useEffect(() => {
    if (cliStatus.authenticated) {
      authPollCancelledRef.current = true;
      authPollRunningRef.current = false;
    }
    return () => {
      authPollCancelledRef.current = true;
      authPollRunningRef.current = false;
    };
  }, [cliStatus.authenticated]);

  // Fetch orgs when modal opens
  useEffect(() => {
    if (showCreateModal && cliStatus.authenticated) {
      void getGitHubOrgs()
        .then(setOrgs)
        .catch(() => setOrgs([]));
      setSelectedOwner(username); // Default to personal account
    }
  }, [showCreateModal, cliStatus.authenticated, username]);

  // Clear isCreatingRepo when status becomes connected
  useEffect(() => {
    if (projectStatus?.status === 'connected' && isCreatingRepo) {
      setIsCreatingRepo(false);
    }
  }, [projectStatus?.status, isCreatingRepo]);

  // If gh CLI not installed, show install prompt
  if (!cliStatus.installed) {
    return (
      <button
        className="github-button github-install"
        onClick={() => void openUrl('https://cli.github.com/')}
        title="Install GitHub CLI"
      >
        <GitHubIcon />
        Install CLI
      </button>
    );
  }

  // If not authenticated, show connect button
  if (!cliStatus.authenticated) {
    return (
      <button
        className="github-button github-connect"
        onClick={() => {
          // Don't start another poll if one is already running
          if (authPollRunningRef.current) return;

          const startAuthFlow = async () => {
            try {
              await openUrl('https://github.com/login/device');
              // Poll for auth completion (with cancellation support)
              authPollCancelledRef.current = false;
              authPollRunningRef.current = true;

              const pollAuth = async () => {
                try {
                  for (let i = 0; i < 60; i++) {
                    if (authPollCancelledRef.current) break;
                    await new Promise((r) => setTimeout(r, 2000));
                    if (authPollCancelledRef.current) break;
                    onGitHubConnect();
                  }
                } finally {
                  authPollRunningRef.current = false;
                }
              };
              // Fire and forget, but properly tracked
              void pollAuth();
            } catch (e) {
              console.error('Failed to start GitHub auth:', e);
              authPollRunningRef.current = false;
            }
          };

          void startAuthFlow();
        }}
        title="Connect your GitHub account"
      >
        <GitHubIcon />
        Connect
      </button>
    );
  }

  // If project has a GitHub repo, show icon link to repo
  if (projectStatus?.status === 'connected' && projectStatus?.github_url) {
    return (
      <button
        className="github-button github-link"
        onClick={() => void openUrl(projectStatus.github_url!)}
        title="Open on GitHub"
      >
        <GitHubIcon />
      </button>
    );
  }

  // Show loading state while creating repo (even after modal closes)
  if (isCreatingRepo) {
    return (
      <button className="github-button github-creating" disabled title="Setting up...">
        <GitHubIcon />
        Setting up...
      </button>
    );
  }

  // Project not connected - show Create Repo button
  return (
    <>
      <button
        className="github-button github-create"
        onClick={() => {
          setRepoName(projectName);
          setShowCreateModal(true);
          setError(null);
        }}
        title="Create GitHub repository"
      >
        <GitHubIcon />
        Create Repo
      </button>

      {/* Create Repo Modal */}
      {showCreateModal && (
        <div
          className="modal-overlay"
          onClick={() => {
            setShowCreateModal(false);
            onModalClose?.();
          }}
        >
          <div className="modal github-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Create GitHub Repository</h3>
            <p>Create a new GitHub repository for this project.</p>

            <div className="github-form">
              <label>
                Owner
                <select
                  className="owner-select"
                  value={selectedOwner || username || ''}
                  onChange={(e) => setSelectedOwner(e.target.value)}
                >
                  {username && <option value={username}>{username}</option>}
                  {orgs.map((org) => (
                    <option key={org} value={org}>
                      {org}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Repository name
                <div className="repo-name-input">
                  <span className="repo-prefix">{selectedOwner || username}/</span>
                  <input
                    type="text"
                    value={repoName}
                    onChange={(e) => setRepoName(e.target.value.replace(/[^a-zA-Z0-9-_]/g, '-'))}
                    placeholder="my-project"
                    autoFocus
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                </div>
              </label>

              <label className="visibility-option">
                <input
                  type="radio"
                  name="visibility"
                  checked={isPrivate}
                  onChange={() => setIsPrivate(true)}
                />
                <div>
                  <strong>Private</strong>
                  <span>Only you can see this repository</span>
                </div>
              </label>

              <label className="visibility-option">
                <input
                  type="radio"
                  name="visibility"
                  checked={!isPrivate}
                  onChange={() => setIsPrivate(false)}
                />
                <div>
                  <strong>Public</strong>
                  <span>Anyone can see this repository</span>
                </div>
              </label>

              {error && <p className="github-error">{error}</p>}
            </div>

            <div className="modal-actions">
              <button
                onClick={() => {
                  setShowCreateModal(false);
                  onModalClose?.();
                }}
                disabled={isLoading}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={() => {
                  if (!repoName.trim()) return;

                  const handleCreate = async () => {
                    setIsLoading(true);
                    setIsCreatingRepo(true);
                    setError(null);
                    try {
                      const owner = selectedOwner || username;
                      const fullRepoName = `${owner}/${repoName}`;
                      await pushToGitHub({
                        projectPath,
                        repoName: fullRepoName,
                        isPrivate,
                      });

                      // Close modal immediately after GitHub repo is created
                      setShowCreateModal(false);
                      setIsLoading(false);
                      onModalClose?.();

                      // Auto-connect to Vercel if authenticated (don't block, but refresh status when done)
                      if (vercelState?.cliStatus.authenticated) {
                        onVercelAutoConnectStart?.();
                        void linkToVercel({
                          projectPath,
                          githubRepo: fullRepoName,
                        })
                          .then(async (deployedUrl) => {
                            // Refresh status first, then end connecting state to avoid flash of "Connect Vercel"
                            await onStatusChange(deployedUrl);
                            onVercelAutoConnectEnd?.();
                          })
                          .catch(async (e) => {
                            console.error('Failed to auto-connect to Vercel:', e);
                            // Still refresh status even on error to show correct state
                            await onStatusChange();
                            onVercelAutoConnectEnd?.();
                          });
                      }

                      // Refresh status - this will clear isCreatingRepo when status updates
                      await onStatusChange();
                      onToast?.('Repository created!', 'success');

                      // Fallback: clear isCreatingRepo after a delay if status doesn't update
                      setTimeout(() => {
                        setIsCreatingRepo(false);
                      }, 3000);
                    } catch (e) {
                      setError(String(e));
                      onToast?.('Failed to create repository', 'error');
                      setIsLoading(false);
                      setIsCreatingRepo(false);
                    }
                  };

                  void handleCreate();
                }}
                disabled={isLoading || !repoName.trim()}
              >
                {isLoading ? 'Creating...' : 'Create Repository'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
