/**
 * ImportProject component that provides a wizard for importing existing GitHub repositories.
 *
 * This is a multi-step wizard that:
 * 1. Lets user select a GitHub account/organization
 * 2. Shows a searchable list of repositories from the selected account
 * 3. Optionally lets user link to a Vercel project
 * 4. Shows progress while cloning and installing dependencies
 *
 * Uses Tauri PTY for running git clone and npm/pnpm/yarn install with progress events.
 *
 * @module components/ImportProject
 */

import { useState, useEffect } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { trackError } from '../lib/analytics';
import {
  getGitHubUsername,
  getGitHubOrgs,
  listGitHubRepos,
  listCollaboratorRepos,
  detectPackageManager,
  GitHubRepo,
} from '../lib/github';
import {
  listProjects,
  ensureShipStudioDir,
  spawnPty,
  ensureGitignoreHasShipstudio,
} from '../lib/project';
import { getWindowLabel } from '../lib/window';
import { checkNpmCachePermissions } from '../lib/setup';

/** Props for the ImportProject component */
interface ImportProjectProps {
  /** Callback when project import completes successfully */
  onComplete: (projectPath: string) => void;
  /** Callback when user cancels the wizard */
  onCancel: () => void;
}

/** Form wizard steps before import starts */
type FormStep = 'select-account' | 'select-repo';
/** Import progress steps */
type Step = 'clone' | 'install' | 'setup' | 'done';

/** Step definitions with display labels */
const STEPS: { id: Step; label: string }[] = [
  { id: 'clone', label: 'Clone repository' },
  { id: 'install', label: 'Install dependencies' },
  { id: 'setup', label: 'Setup project' },
  { id: 'done', label: 'Done' },
];

/** User-facing status messages for each import step */
const STATUS_MESSAGES: Record<Step, string> = {
  clone: 'Cloning repository...',
  install: 'Installing dependencies... This may take a minute.',
  setup: 'Setting up project...',
  done: 'Almost done...',
};

export function ImportProject({ onComplete, onCancel }: ImportProjectProps) {
  const [formStep, setFormStep] = useState<FormStep>('select-account');
  const [username, setUsername] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<string[]>([]);
  const [selectedOwner, setSelectedOwner] = useState<string | null>(null);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [currentStep, setCurrentStep] = useState<Step>('clone');
  const [error, setError] = useState<string | null>(null);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [importedProjectPath, setImportedProjectPath] = useState<string | null>(null);
  const [importedPackageManager, setImportedPackageManager] = useState<string>('npm');

  // Load user and orgs on mount
  useEffect(() => {
    void loadAccounts();
  }, []);

  const loadAccounts = async () => {
    setLoadingAccounts(true);
    try {
      const [user, orgList] = await Promise.all([getGitHubUsername(), getGitHubOrgs()]);
      setUsername(user);
      setOrgs(orgList);
      // Auto-select personal account
      setSelectedOwner(user);
    } catch (err) {
      trackError('github_accounts_load', err, 'Dashboard');
      setError('Failed to load GitHub accounts. Please check your authentication.');
    } finally {
      setLoadingAccounts(false);
    }
  };

  // Load repos when owner changes
  useEffect(() => {
    if (selectedOwner) {
      void loadRepos(selectedOwner);
    }
  }, [selectedOwner]);

  const loadRepos = async (owner: string) => {
    setLoadingRepos(true);
    setRepos([]);
    setSelectedRepo(null);
    setError(null);
    try {
      // Special case: "collaborator" fetches repos where user is a collaborator
      const repoList =
        owner === '__collaborator__' ? await listCollaboratorRepos() : await listGitHubRepos(owner);
      // Sort by updated date (most recent first)
      repoList.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      setRepos(repoList);
    } catch (e) {
      trackError('github_repos_load', e, 'Dashboard');
      setError(`Failed to load repositories: ${String(e)}`);
    } finally {
      setLoadingRepos(false);
    }
  };

  const waitForPtyExit = async (targetId: number): Promise<number | null> => {
    return new Promise((resolve, reject) => {
      let unlistenExit: UnlistenFn | null = null;
      let unlistenOutput: UnlistenFn | null = null;
      const outputLines: string[] = [];
      const MAX_OUTPUT_LINES = 30;

      // Capture process output so we can surface it on failure
      void listen<{ id: number; data: string }>('pty-output', (event) => {
        if (event.payload.id === targetId) {
          // Split into lines and keep a rolling window
          const lines = event.payload.data.split(/\r?\n/).filter((l) => l.trim());
          for (const line of lines) {
            outputLines.push(line);
            if (outputLines.length > MAX_OUTPUT_LINES) outputLines.shift();
          }
        }
      }).then((fn) => {
        unlistenOutput = fn;
      });

      void listen<{ id: number; code: number | null }>('pty-exit', (event) => {
        if (event.payload.id === targetId) {
          unlistenExit?.();
          unlistenOutput?.();
          if (event.payload.code === 0 || event.payload.code === null) {
            resolve(event.payload.code);
          } else {
            const output = outputLines.join('\n').trim();
            const msg = output
              ? `Process exited with code ${event.payload.code}\n\n${output}`
              : `Process exited with code ${event.payload.code}`;
            reject(new Error(msg));
          }
        }
      }).then((fn) => {
        unlistenExit = fn;
      });
    });
  };

  /** Map PTY exit codes to user-friendly error messages */
  const getFriendlyError = (err: unknown): string => {
    const msg = String(err);
    const codeMatch = msg.match(/Process exited with code (\d+)/);
    if (codeMatch) {
      const code = parseInt(codeMatch[1]);
      if (code === 243) {
        return "npm couldn't access its cache directory (~/.npm). This usually happens when npm was previously run with sudo.\n\nTo fix, open a terminal and run:\nsudo chown -R $(whoami) ~/.npm";
      }
      if (code === 128) {
        return "Git authentication failed. Make sure you're signed into GitHub.";
      }
    }
    // Strip the "Error: " prefix that comes from Error.toString()
    return msg.replace(/^Error:\s*/, '');
  };

  /** Run package manager install via PTY, with a pre-check for permissions */
  const runPackageInstall = async (projectPath: string, packageManager: string) => {
    // Pre-check: verify npm cache is writable (relevant for npm/npx, and sometimes pnpm/yarn too)
    const cacheStatus = await checkNpmCachePermissions();
    if (cacheStatus === 'not_writable') {
      throw new Error(
        "npm can't write to its cache directory (~/.npm). This usually happens when npm was previously run with sudo.\n\nTo fix, open a terminal and run:\nsudo chown -R $(whoami) ~/.npm"
      );
    }

    const installId = await spawnPty(
      {
        cwd: projectPath,
        command: packageManager,
        args: ['install'],
        rows: 10,
        cols: 80,
      },
      getWindowLabel()
    );

    await waitForPtyExit(installId);
  };

  /** Retry just the install step (project already cloned) */
  const retryInstall = async () => {
    if (!importedProjectPath) return;

    setError(null);
    setCurrentStep('install');

    try {
      await runPackageInstall(importedProjectPath, importedPackageManager);

      // Setup project
      setCurrentStep('setup');
      await ensureGitignoreHasShipstudio(importedProjectPath);

      setCurrentStep('done');
      await new Promise((r) => setTimeout(r, 800));
      onComplete(importedProjectPath);
    } catch (err) {
      trackError('project_install_retry', err, 'Dashboard');
      setError(getFriendlyError(err));
    }
  };

  const handleImport = async () => {
    if (!selectedRepo) {
      setError('Please select a repository');
      return;
    }

    const safeName = selectedRepo.name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (!safeName) {
      setError('Invalid repository name');
      return;
    }

    // Check for duplicate project names
    try {
      const existingProjects = await listProjects();
      const duplicate = existingProjects.find(
        (p) => p.name.toLowerCase() === safeName.toLowerCase()
      );
      if (duplicate) {
        setError(`A project named "${safeName}" already exists`);
        return;
      }
    } catch {
      // If we can't check, proceed anyway
    }

    setIsImporting(true);
    setError(null);
    setCurrentStep('clone');

    try {
      // Ensure ShipStudio directory exists
      const shipstudioDir = await ensureShipStudioDir();
      const projectPath = `${shipstudioDir}/${safeName}`;

      // Clone repository using gh CLI (uses GitHub CLI authentication)
      // For collaborator repos, the name already includes the owner (e.g., "owner/repo")
      const repoFullName =
        selectedOwner === '__collaborator__'
          ? selectedRepo.name
          : `${selectedOwner}/${selectedRepo.name}`;
      const cloneId = await spawnPty(
        {
          cwd: shipstudioDir,
          command: 'gh',
          args: ['repo', 'clone', repoFullName, safeName],
          rows: 10,
          cols: 80,
        },
        getWindowLabel()
      );

      await waitForPtyExit(cloneId);

      // Detect package manager and install dependencies
      setCurrentStep('install');
      const packageManager = await detectPackageManager(projectPath);
      setImportedProjectPath(projectPath);
      setImportedPackageManager(packageManager);

      await runPackageInstall(projectPath, packageManager);

      // Setup project
      setCurrentStep('setup');

      // Ensure .shipstudio is gitignored
      await ensureGitignoreHasShipstudio(projectPath);

      setCurrentStep('done');

      // Small delay before opening
      await new Promise((r) => setTimeout(r, 800));
      onComplete(projectPath);
    } catch (err) {
      trackError('project_import', err, 'Dashboard');
      setError(getFriendlyError(err));
    }
  };

  const getStepStatus = (stepId: Step): 'pending' | 'active' | 'done' => {
    const stepOrder = STEPS.map((s) => s.id);
    const currentIndex = stepOrder.indexOf(currentStep);
    const stepIndex = stepOrder.indexOf(stepId);

    if (stepIndex < currentIndex) return 'done';
    if (stepIndex === currentIndex) return 'active';
    return 'pending';
  };

  // Filter repos based on search
  const filteredRepos = repos.filter((repo) => {
    if (!searchQuery) return true;
    return (
      repo.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (repo.description && repo.description.toLowerCase().includes(searchQuery.toLowerCase()))
    );
  });

  const handleOwnerSelect = (owner: string) => {
    setSelectedOwner(owner);
    setFormStep('select-repo');
    setSelectedRepo(null);
    setSearchQuery('');
  };

  const handleRepoSelect = (repo: GitHubRepo) => {
    setSelectedRepo(repo);
  };

  const handleBack = () => {
    if (formStep === 'select-repo') {
      setFormStep('select-account');
      setSelectedRepo(null);
      setSearchQuery('');
    }
  };

  const renderContent = () => {
    // Importing state - show progress
    if (isImporting) {
      return (
        <div className="create-modal-content creating">
          <h2>Importing "{selectedRepo?.name}"</h2>

          <div className="create-spinner" />

          <p className="create-status">{STATUS_MESSAGES[currentStep]}</p>

          <div className="create-checklist">
            {STEPS.slice(0, -1).map((step) => {
              const status = getStepStatus(step.id);
              return (
                <div key={step.id} className={`checklist-item ${status}`}>
                  {status === 'done' ? (
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : status === 'active' ? (
                    <div className="checklist-spinner" />
                  ) : (
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <circle cx="12" cy="12" r="10" />
                    </svg>
                  )}
                  <span>{step.label}</span>
                </div>
              );
            })}
          </div>

          {error && (
            <div className="create-error">
              <p style={{ whiteSpace: 'pre-line', maxHeight: '200px', overflowY: 'auto' }}>
                {error}
              </p>
              <div style={{ display: 'flex', gap: '8px' }}>
                {currentStep === 'install' && importedProjectPath && (
                  <button className="btn-primary" onClick={() => void retryInstall()}>
                    Retry
                  </button>
                )}
                <button onClick={onCancel}>Close</button>
              </div>
            </div>
          )}
        </div>
      );
    }

    // Loading accounts
    if (loadingAccounts) {
      return (
        <div className="create-modal-content creating">
          <div className="create-spinner" />
          <p className="create-status">Loading GitHub accounts...</p>
        </div>
      );
    }

    // Account selection step
    if (formStep === 'select-account') {
      return (
        <div className="create-modal-content">
          <div className="create-modal-header">
            <div>
              <h2>Import Project</h2>
              <p>Select a GitHub account</p>
            </div>
            <button className="create-modal-close" onClick={onCancel} type="button">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <div className="import-owner-list">
            {username && (
              <button
                className={`import-owner-btn ${selectedOwner === username ? 'selected' : ''}`}
                onClick={() => handleOwnerSelect(username)}
              >
                <div className="import-owner-avatar">{username[0].toUpperCase()}</div>
                <div className="import-owner-info">
                  <span className="import-owner-name">{username}</span>
                  <span className="import-owner-type">Personal</span>
                </div>
              </button>
            )}
            {orgs.map((org) => (
              <button
                key={org}
                className={`import-owner-btn ${selectedOwner === org ? 'selected' : ''}`}
                onClick={() => handleOwnerSelect(org)}
              >
                <div className="import-owner-avatar org">{org[0].toUpperCase()}</div>
                <div className="import-owner-info">
                  <span className="import-owner-name">{org}</span>
                  <span className="import-owner-type">Organization</span>
                </div>
              </button>
            ))}
            {/* Collaborator repos - repos owned by others where user has access */}
            <button
              className={`import-owner-btn ${selectedOwner === '__collaborator__' ? 'selected' : ''}`}
              onClick={() => handleOwnerSelect('__collaborator__')}
            >
              <div className="import-owner-avatar collab">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <div className="import-owner-info">
                <span className="import-owner-name">Collaborator Access</span>
                <span className="import-owner-type">Repos shared with you</span>
              </div>
            </button>
          </div>

          {error && <p className="error">{error}</p>}

          <div className="create-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      );
    }

    // Repository selection step
    if (formStep === 'select-repo') {
      return (
        <div className="create-modal-content import-repo-step">
          <div className="create-modal-header">
            <div>
              <h2>Import Project</h2>
              <p className="template-context">
                {selectedOwner === '__collaborator__' ? (
                  <>Repos shared with you</>
                ) : (
                  <>
                    From <strong>{selectedOwner}</strong>
                  </>
                )}
              </p>
            </div>
            <button className="create-modal-close" onClick={onCancel} type="button">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <div className="import-search">
            <input
              type="text"
              placeholder="Search repositories..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>

          <div className="import-repo-list">
            {loadingRepos ? (
              <div className="import-repo-loading">
                <div className="checklist-spinner" />
                <span>Loading repositories...</span>
              </div>
            ) : filteredRepos.length === 0 ? (
              <div className="import-repo-empty">
                {searchQuery ? (
                  <p>No repositories found matching "{searchQuery}"</p>
                ) : (
                  <p>No repositories found</p>
                )}
              </div>
            ) : (
              filteredRepos.map((repo) => (
                <button
                  key={repo.name}
                  className={`import-repo-item ${selectedRepo?.name === repo.name ? 'selected' : ''}`}
                  onClick={() => handleRepoSelect(repo)}
                >
                  <div className="import-repo-header">
                    <span className="import-repo-name">{repo.name}</span>
                    {repo.isPrivate && <span className="import-repo-badge private">Private</span>}
                    {repo.primaryLanguage && (
                      <span className="import-repo-badge lang">{repo.primaryLanguage.name}</span>
                    )}
                  </div>
                  {repo.description && (
                    <p className="import-repo-description">{repo.description}</p>
                  )}
                </button>
              ))
            )}
          </div>

          {error && <p className="error">{error}</p>}

          <div className="create-actions">
            <button type="button" onClick={handleBack}>
              Back
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!selectedRepo}
              onClick={() => void handleImport()}
            >
              Import Project
            </button>
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <div
      className="create-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isImporting) {
          onCancel();
        }
      }}
    >
      <div className="create-modal import-modal">{renderContent()}</div>
    </div>
  );
}
