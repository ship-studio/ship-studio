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
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import {
  getGitHubUsername,
  getGitHubOrgs,
  listGitHubRepos,
  detectPackageManager,
  GitHubRepo,
} from '../lib/github';
import {
  checkVercelCliStatus,
  getVercelUsername,
  getVercelTeams,
  listVercelProjects,
  writeVercelProjectJson,
  VercelTeam,
  VercelProject,
} from '../lib/vercel';

/** Props for the ImportProject component */
interface ImportProjectProps {
  /** Callback when project import completes successfully */
  onComplete: (projectPath: string) => void;
  /** Callback when user cancels the wizard */
  onCancel: () => void;
}

/** Form wizard steps before import starts */
type FormStep = 'select-account' | 'select-repo' | 'select-vercel';
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

  // Vercel state
  const [vercelAuthenticated, setVercelAuthenticated] = useState(false);
  const [vercelUsername, setVercelUsername] = useState<string | null>(null);
  const [vercelTeams, setVercelTeams] = useState<VercelTeam[]>([]);
  const [selectedVercelScope, setSelectedVercelScope] = useState<string>('');
  const [vercelProjects, setVercelProjects] = useState<VercelProject[]>([]);
  const [loadingVercelProjects, setLoadingVercelProjects] = useState(false);
  const [selectedVercelProject, setSelectedVercelProject] = useState<VercelProject | null>(null);
  const [vercelSearchQuery, setVercelSearchQuery] = useState('');

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

      // Also check Vercel status
      const vercelStatus = await checkVercelCliStatus();
      setVercelAuthenticated(vercelStatus.authenticated);
      if (vercelStatus.authenticated) {
        const [vcUsername, vcTeams] = await Promise.all([
          getVercelUsername().catch(() => null),
          getVercelTeams().catch(() => []),
        ]);
        setVercelUsername(vcUsername);
        setVercelTeams(vcTeams);
      }
    } catch {
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

  // Load Vercel projects when scope changes
  useEffect(() => {
    if (formStep === 'select-vercel' && vercelAuthenticated) {
      void loadVercelProjects(selectedVercelScope);
    }
  }, [selectedVercelScope, formStep, vercelAuthenticated]);

  const loadRepos = async (owner: string) => {
    setLoadingRepos(true);
    setRepos([]);
    setSelectedRepo(null);
    setError(null);
    try {
      const repoList = await listGitHubRepos(owner);
      // Sort by updated date (most recent first)
      repoList.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      setRepos(repoList);
    } catch (e) {
      setError(`Failed to load repositories: ${String(e)}`);
    } finally {
      setLoadingRepos(false);
    }
  };

  const loadVercelProjects = async (scope: string) => {
    setLoadingVercelProjects(true);
    setVercelProjects([]);
    setSelectedVercelProject(null);
    try {
      const projects = await listVercelProjects(scope);
      setVercelProjects(projects);
    } catch (e) {
      console.error('Failed to load Vercel projects:', e);
    } finally {
      setLoadingVercelProjects(false);
    }
  };

  const waitForPtyExit = async (targetId: number): Promise<number | null> => {
    return new Promise((resolve, reject) => {
      let unlisten: UnlistenFn | null = null;

      void listen<{ id: number; code: number | null }>('pty-exit', (event) => {
        if (event.payload.id === targetId) {
          unlisten?.();
          if (event.payload.code === 0 || event.payload.code === null) {
            resolve(event.payload.code);
          } else {
            reject(new Error(`Process exited with code ${event.payload.code}`));
          }
        }
      }).then((fn) => {
        unlisten = fn;
      });
    });
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
      const existingProjects = await invoke<{ name: string; path: string }[]>('list_projects');
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
      const shipstudioDir = await invoke<string>('ensure_shipstudio_dir');
      const projectPath = `${shipstudioDir}/${safeName}`;

      // Clone repository using gh CLI (uses GitHub CLI authentication)
      const repoFullName = `${selectedOwner}/${selectedRepo.name}`;
      const cloneId = await invoke<number>('spawn_pty', {
        options: {
          cwd: shipstudioDir,
          command: 'gh',
          args: ['repo', 'clone', repoFullName, safeName],
          rows: 10,
          cols: 80,
        },
      });

      await waitForPtyExit(cloneId);

      // Detect package manager and install dependencies
      setCurrentStep('install');
      const packageManager = await detectPackageManager(projectPath);

      const installId = await invoke<number>('spawn_pty', {
        options: {
          cwd: projectPath,
          command: packageManager,
          args: ['install'],
          rows: 10,
          cols: 80,
        },
      });

      await waitForPtyExit(installId);

      // Setup project
      setCurrentStep('setup');

      // Ensure .shipstudio is gitignored
      await invoke('ensure_gitignore_has_shipstudio', { projectPath });

      // Write .vercel/project.json if a Vercel project was selected
      if (selectedVercelProject) {
        await writeVercelProjectJson(
          projectPath,
          selectedVercelProject.id,
          selectedVercelProject.orgId
        );
      }

      setCurrentStep('done');

      // Small delay before opening
      await new Promise((r) => setTimeout(r, 800));
      onComplete(projectPath);
    } catch (err) {
      setError(String(err));
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

  // Filter Vercel projects based on search
  const filteredVercelProjects = vercelProjects.filter((project) => {
    if (!vercelSearchQuery) return true;
    return project.name.toLowerCase().includes(vercelSearchQuery.toLowerCase());
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

  const handleContinueToVercel = () => {
    if (vercelAuthenticated) {
      setFormStep('select-vercel');
      setVercelSearchQuery('');
      // Load projects for initial scope
      void loadVercelProjects(selectedVercelScope);
    } else {
      // Skip Vercel step if not authenticated
      void handleImport();
    }
  };

  const handleBack = () => {
    if (formStep === 'select-repo') {
      setFormStep('select-account');
      setSelectedRepo(null);
      setSearchQuery('');
    } else if (formStep === 'select-vercel') {
      setFormStep('select-repo');
      setSelectedVercelProject(null);
      setVercelSearchQuery('');
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
              <p>{error}</p>
              <button onClick={onCancel}>Close</button>
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
                From <strong>{selectedOwner}</strong>
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

          <div className="import-warning">
            Ship Studio is optimized for Next.js. Other projects may not work as intended.
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
              onClick={handleContinueToVercel}
            >
              {vercelAuthenticated ? 'Continue' : 'Import Project'}
            </button>
          </div>
        </div>
      );
    }

    // Vercel project selection step
    return (
      <div className="create-modal-content import-repo-step">
        <div className="create-modal-header">
          <div>
            <h2>Link to Vercel</h2>
            <p className="template-context">
              Importing <strong>{selectedRepo?.name}</strong>
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

        {/* Vercel scope selector */}
        <div className="import-vercel-scope">
          <label>Vercel Account</label>
          <div className="import-scope-buttons">
            <button
              className={`import-scope-btn ${selectedVercelScope === '' ? 'selected' : ''}`}
              onClick={() => setSelectedVercelScope('')}
            >
              {vercelUsername || 'Personal'}
            </button>
            {vercelTeams.map((team) => (
              <button
                key={team.id}
                className={`import-scope-btn ${selectedVercelScope === team.id ? 'selected' : ''}`}
                onClick={() => setSelectedVercelScope(team.id)}
              >
                {team.name}
              </button>
            ))}
          </div>
        </div>

        <div className="import-search">
          <input
            type="text"
            placeholder="Search Vercel projects..."
            value={vercelSearchQuery}
            onChange={(e) => setVercelSearchQuery(e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </div>

        <div className="import-repo-list">
          {loadingVercelProjects ? (
            <div className="import-repo-loading">
              <div className="checklist-spinner" />
              <span>Loading Vercel projects...</span>
            </div>
          ) : filteredVercelProjects.length === 0 ? (
            <div className="import-repo-empty">
              {vercelSearchQuery ? (
                <p>No projects found matching "{vercelSearchQuery}"</p>
              ) : (
                <p>No Vercel projects found</p>
              )}
            </div>
          ) : (
            filteredVercelProjects.map((project) => (
              <button
                key={project.id}
                className={`import-repo-item ${selectedVercelProject?.id === project.id ? 'selected' : ''}`}
                onClick={() => setSelectedVercelProject(project)}
              >
                <div className="import-repo-header">
                  <span className="import-repo-name">{project.name}</span>
                </div>
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
            className="btn-secondary"
            onClick={() => {
              setSelectedVercelProject(null);
              void handleImport();
            }}
          >
            Skip
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!selectedVercelProject}
            onClick={() => void handleImport()}
          >
            Import Project
          </button>
        </div>
      </div>
    );
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
