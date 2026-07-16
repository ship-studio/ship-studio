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
import { trackError } from '../../lib/analytics';
import {
  getGitHubUsername,
  getGitHubOrgs,
  listGitHubRepos,
  listCollaboratorRepos,
  detectPackageManager,
  GitHubRepo,
} from '../../lib/github';
import {
  ensureShipStudioDir,
  projectPathExists,
  ensureGitignoreHasShipstudio,
  detectWorkspaces,
  setWorkspaceSubpath,
  type WorkspaceInfo,
} from '../../lib/project';
import { runPtyToExit } from '../../lib/ptyRun';
import { checkNpmCachePermissions } from '../../lib/setup';
import { Step1AccountSelection } from '../import-project/steps/Step1AccountSelection';
import { Step2RepoSelection } from '../import-project/steps/Step2RepoSelection';
import { Step3ImportProgress, type Step } from '../import-project/steps/Step3ImportProgress';
import {
  Step3WorkspacePicker,
  type WorkspacePick,
} from '../import-project/steps/Step3WorkspacePicker';
import { logger } from '../../lib/logger';
import { asCommandError, formatCommandError, friendlyProcessError } from '../../lib/errors';
import { Spinner } from '../primitives/Spinner';

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
      setError(
        `Couldn't load your GitHub accounts: ${formatCommandError(asCommandError(err))}. ` +
          'Try signing out and back into GitHub.'
      );
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
      setError(`Failed to load repositories: ${formatCommandError(asCommandError(e))}`);
    } finally {
      setLoadingRepos(false);
    }
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

    logger.info('[ImportProject] phase: install', { projectPath, packageManager });
    await runPtyToExit({
      cwd: projectPath,
      command: packageManager,
      args: ['install'],
      rows: 10,
      cols: 80,
    });
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
      logger.error('[ImportProject] install retry failed', {
        error: err instanceof Error ? err.message : String(err),
        projectPath: importedProjectPath,
        packageManager: importedPackageManager,
      });
      trackError('project_install_retry', err, 'Dashboard');
      setError(friendlyProcessError(err));
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

    let shipstudioDir: string;
    try {
      shipstudioDir = await ensureShipStudioDir();
    } catch (err) {
      trackError('project_import', err, 'Dashboard');
      setError(friendlyProcessError(err));
      return;
    }

    // Auto-suffix on collision so re-importing a monorepo for a different
    // workspace doesn't error out (`sugar-shark`, `sugar-shark-2`, ...).
    let safeName = baseName;
    let counter = 2;
    try {
      while (await projectPathExists(`${shipstudioDir}/${safeName}`)) {
        safeName = `${baseName}-${counter}`;
        counter += 1;
        if (counter > 50) {
          setError(`Too many copies of "${baseName}" already exist`);
          return;
        }
      }
    } catch (err) {
      trackError('project_import', err, 'Dashboard');
      setError(friendlyProcessError(err));
      return;
    }

    setIsImporting(true);
    setError(null);
    setCurrentStep('clone');
    setDiscoveredWorkspaces([]);
    setSelectedWorkspacePick(null);
    setAwaitingWorkspacePick(false);

    try {
      const projectPath = `${shipstudioDir}/${safeName}`;

      // Clone repository using gh CLI (uses GitHub CLI authentication)
      // For collaborator repos, the name already includes the owner (e.g., "owner/repo")
      const repoFullName =
        selectedOwner === '__collaborator__'
          ? selectedRepo.name
          : `${selectedOwner}/${selectedRepo.name}`;

      // Breadcrumb: log sanitized import parameters (names + paths only, no
      // tokens) before invoking, so a crash mid-import localizes the phase.
      logger.info('[ImportProject] phase: clone', {
        repo: repoFullName,
        safeName,
        projectPath,
      });
      await runPtyToExit({
        cwd: shipstudioDir,
        command: 'gh',
        args: ['repo', 'clone', repoFullName, safeName],
        rows: 10,
        cols: 80,
      });
      logger.info('[ImportProject] clone complete', { projectPath });

      setImportedProjectPath(projectPath);

      // If this is a monorepo with runnable apps, pause for the user to pick
      // which one this project will focus on. Empty result → single-package
      // repo, fall through to the normal install flow. Errors are logged so
      // a backend failure shows up in the dev console instead of being eaten.
      let workspaces: WorkspaceInfo[] = [];
      try {
        logger.info('[ImportProject] phase: detect workspaces', { projectPath });
        workspaces = await detectWorkspaces(projectPath);
      } catch (err) {
        logger.warn('[ImportProject] detectWorkspaces failed; falling back to root', {
          error: err instanceof Error ? err.message : String(err),
          projectPath,
        });
      }

      if (workspaces.length > 0) {
        logger.info('[ImportProject] monorepo detected; awaiting workspace pick', {
          projectPath,
          workspaceCount: workspaces.length,
        });
        const firstWeb = workspaces.find((w) => w.isWeb) ?? workspaces[0];
        setDiscoveredWorkspaces(workspaces);
        setSelectedWorkspacePick({ kind: 'app', relativePath: firstWeb.relativePath });
        setAwaitingWorkspacePick(true);
        return;
      }

      await finishImport(projectPath);
    } catch (err) {
      logger.error('[ImportProject] import failed during clone/detect', {
        error: err instanceof Error ? err.message : String(err),
        repo: selectedRepo.name,
        safeName,
      });
      trackError('project_import', err, 'Dashboard');
      setError(friendlyProcessError(err));
    }
  };

  /** Resume install + setup after clone (and optionally after the workspace picker). */
  const finishImport = async (projectPath: string) => {
    // Local phase tracker for error breadcrumbs — the `currentStep` state is
    // stale inside this closure, so it can't localize the failure.
    let phase = 'detect-package-manager';
    try {
      // Not every repo is an npm project (Flutter, plain HTML, Rust, …).
      // `npm install` exits ENOENT when there's no package.json, killing the
      // import after a successful clone — skip the install step instead, the
      // same way the zip-template path does.
      const hasPackageJson = await projectPathExists(`${projectPath}/package.json`);

      if (hasPackageJson) {
        setCurrentStep('install');
        const packageManager = await detectPackageManager(projectPath);
        setImportedPackageManager(packageManager);

        phase = 'install';
        await runPackageInstall(projectPath, packageManager);
      }

      phase = 'setup';
      setCurrentStep('setup');
      logger.info('[ImportProject] phase: setup', { projectPath });
      await ensureGitignoreHasShipstudio(projectPath);

      setCurrentStep('done');
      logger.info('[ImportProject] import complete', { projectPath });
      await new Promise((r) => setTimeout(r, 800));
      onComplete(projectPath);
    } catch (err) {
      logger.error('[ImportProject] import failed', {
        error: err instanceof Error ? err.message : String(err),
        phase,
        projectPath,
      });
      trackError('project_import', err, 'Dashboard');
      setError(friendlyProcessError(err));
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
      setError(friendlyProcessError(err));
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
          <Spinner size="lg" className="create-spinner" />
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
