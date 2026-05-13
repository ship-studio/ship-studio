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
  detectWorkspaces,
  setWorkspaceSubpath,
  type WorkspaceInfo,
} from '../lib/project';
import { getWindowLabel } from '../lib/window';
import { checkNpmCachePermissions } from '../lib/setup';
import { Step1AccountSelection } from './import-project/steps/Step1AccountSelection';
import { Step2RepoSelection } from './import-project/steps/Step2RepoSelection';
import { Step3ImportProgress, type Step } from './import-project/steps/Step3ImportProgress';
import {
  Step3WorkspacePicker,
  type WorkspacePick,
} from './import-project/steps/Step3WorkspacePicker';
import { logger } from '../lib/logger';

/** Props for the ImportProject component */
interface ImportProjectProps {
  /** Callback when project import completes successfully */
  onComplete: (projectPath: string) => void;
  /** Callback when user cancels the wizard */
  onCancel: () => void;
}

/** Form wizard steps before import starts */
type FormStep = 'select-account' | 'select-repo';

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
  const [discoveredWorkspaces, setDiscoveredWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [selectedWorkspacePick, setSelectedWorkspacePick] = useState<WorkspacePick | null>(null);
  const [awaitingWorkspacePick, setAwaitingWorkspacePick] = useState(false);

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

    const baseName = selectedRepo.name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (!baseName) {
      setError('Invalid repository name');
      return;
    }

    // Auto-suffix on collision so re-importing a monorepo for a different
    // workspace doesn't error out (`sugar-shark`, `sugar-shark-2`, ...).
    let safeName = baseName;
    try {
      const existingProjects = await listProjects();
      const existingNames = new Set(existingProjects.map((p) => p.name.toLowerCase()));
      let counter = 2;
      while (existingNames.has(safeName.toLowerCase())) {
        safeName = `${baseName}-${counter}`;
        counter += 1;
        if (counter > 50) {
          setError(`Too many copies of "${baseName}" already exist`);
          return;
        }
      }
    } catch {
      // If we can't check, proceed with the base name
    }

    setIsImporting(true);
    setError(null);
    setCurrentStep('clone');
    setDiscoveredWorkspaces([]);
    setSelectedWorkspacePick(null);
    setAwaitingWorkspacePick(false);

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

      setImportedProjectPath(projectPath);

      // If this is a monorepo with runnable apps, pause for the user to pick
      // which one this project will focus on. Empty result → single-package
      // repo, fall through to the normal install flow. Errors are logged so
      // a backend failure shows up in the dev console instead of being eaten.
      let workspaces: WorkspaceInfo[] = [];
      try {
        workspaces = await detectWorkspaces(projectPath);
      } catch (err) {
        logger.warn('[ImportProject] detectWorkspaces failed; falling back to root', {
          error: err instanceof Error ? err.message : String(err),
          projectPath,
        });
      }

      if (workspaces.length > 0) {
        const firstWeb = workspaces.find((w) => w.isWeb) ?? workspaces[0];
        setDiscoveredWorkspaces(workspaces);
        setSelectedWorkspacePick({ kind: 'app', relativePath: firstWeb.relativePath });
        setAwaitingWorkspacePick(true);
        return;
      }

      await finishImport(projectPath);
    } catch (err) {
      trackError('project_import', err, 'Dashboard');
      setError(getFriendlyError(err));
    }
  };

  /** Resume install + setup after clone (and optionally after the workspace picker). */
  const finishImport = async (projectPath: string) => {
    try {
      setCurrentStep('install');
      const packageManager = await detectPackageManager(projectPath);
      setImportedPackageManager(packageManager);

      await runPackageInstall(projectPath, packageManager);

      setCurrentStep('setup');
      await ensureGitignoreHasShipstudio(projectPath);

      setCurrentStep('done');
      await new Promise((r) => setTimeout(r, 800));
      onComplete(projectPath);
    } catch (err) {
      trackError('project_import', err, 'Dashboard');
      setError(getFriendlyError(err));
    }
  };

  const handleConfirmWorkspacePick = async () => {
    if (!importedProjectPath || !selectedWorkspacePick) return;
    // Root pick → record an empty string so the open-time gate doesn't
    // re-prompt; app pick → its relative subpath.
    const subpath = selectedWorkspacePick.kind === 'root' ? '' : selectedWorkspacePick.relativePath;
    try {
      await setWorkspaceSubpath(importedProjectPath, subpath);
    } catch (err) {
      trackError('project_import_workspace_save', err, 'Dashboard');
      setError(getFriendlyError(err));
      return;
    }
    setAwaitingWorkspacePick(false);
    await finishImport(importedProjectPath);
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
    // Pause for the monorepo picker between clone and install.
    if (awaitingWorkspacePick && discoveredWorkspaces.length > 0 && !error) {
      return (
        <Step3WorkspacePicker
          repoName={selectedRepo?.name ?? ''}
          workspaces={discoveredWorkspaces}
          selectedPick={selectedWorkspacePick}
          onSelect={setSelectedWorkspacePick}
          onConfirm={() => void handleConfirmWorkspacePick()}
          onCancel={onCancel}
        />
      );
    }

    // Importing state - show progress
    if (isImporting) {
      return (
        <Step3ImportProgress
          repoName={selectedRepo?.name ?? ''}
          currentStep={currentStep}
          error={error}
          importedProjectPath={importedProjectPath}
          onRetryInstall={() => void retryInstall()}
          onCancel={onCancel}
        />
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
        <Step1AccountSelection
          username={username}
          orgs={orgs}
          selectedOwner={selectedOwner}
          error={error}
          onOwnerSelect={handleOwnerSelect}
          onCancel={onCancel}
        />
      );
    }

    // Repository selection step
    if (formStep === 'select-repo') {
      return (
        <Step2RepoSelection
          selectedOwner={selectedOwner}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          loadingRepos={loadingRepos}
          filteredRepos={filteredRepos}
          selectedRepo={selectedRepo}
          onRepoSelect={handleRepoSelect}
          error={error}
          onBack={handleBack}
          onImport={() => void handleImport()}
          onCancel={onCancel}
        />
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
