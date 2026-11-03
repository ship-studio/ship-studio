/**
 * GitHub CLI integration utilities.
 *
 * Provides functions for:
 * - Checking GitHub CLI (gh) installation and authentication
 * - Creating and managing GitHub repositories
 * - Pushing changes and publishing to branches
 * - Branch status comparison (staging vs production)
 *
 * All operations use the GitHub CLI via Tauri backend commands.
 *
 * @module lib/github
 */

import { invoke } from '@tauri-apps/api/core';

/** GitHub CLI installation and authentication status */
export interface GitHubCliStatus {
  /** Whether gh CLI is installed */
  installed: boolean;
  /** Whether user is logged in to GitHub */
  authenticated: boolean;
}

/** Project's GitHub repository connection status */
export interface ProjectGitHubStatus {
  /**
   * Connection state.
   *
   * `other-remote` is a project whose `origin` points somewhere the GitHub
   * integration doesn't reach — GitLab, a self-managed instance, another
   * forge. It is deliberately distinct from `no-remote`: the code has a home,
   * we just don't talk to it, so the UI must not offer to create a GitHub
   * repository as though the project had none.
   */
  status: 'not-a-repo' | 'no-remote' | 'other-remote' | 'connected';
  /** Repository identifier (e.g., "username/repo-name") - only set if connected */
  github_repo: string | null;
  /** Full repository URL (e.g., "https://github.com/username/repo-name") - only set if connected */
  github_url: string | null;
  /** Host of the configured `origin` (e.g. "gitlab.com") - only set for `other-remote` */
  remote_host: string | null;
  /**
   * Display name of the forge that host identifies ("GitLab"), where it
   * identifies one. `null` for a host we can read but can't classify — show
   * {@link remote_host} rather than guessing a vendor. Only set for
   * `other-remote`.
   */
  remote_forge: string | null;
}

/**
 * What to call the place this project's code lives, in UI copy.
 *
 * Returns `"GitHub"` for a connected project, the forge name or bare host for
 * a remote we don't integrate with, and `null` when there's no remote to name.
 * Prefer this over hardcoding "GitHub" in any string a non-GitHub project can
 * reach — that copy is how a GitLab user gets told their push went to the
 * wrong place.
 */
export function remoteLabel(status: ProjectGitHubStatus | null): string | null {
  if (!status) return null;
  if (status.status === 'connected') return 'GitHub';
  if (status.status === 'other-remote') return status.remote_forge ?? status.remote_host;
  return null;
}

/**
 * Whether `git push` has somewhere to go.
 *
 * True for any configured remote, GitHub or not — pushing is plain git and
 * never needed the GitHub integration. Gating the Push button on a *GitHub*
 * repo is what left GitLab projects unable to push from the app at all.
 */
export function hasPushableRemote(status: ProjectGitHubStatus | null): boolean {
  return status?.status === 'connected' || status?.status === 'other-remote';
}

/**
 * Check GitHub CLI installation and authentication status.
 * @returns CLI status with installed and authenticated flags
 */
export async function checkGitHubCliStatus(): Promise<GitHubCliStatus> {
  return invoke<GitHubCliStatus>('check_github_cli_status');
}

/**
 * Get the authenticated GitHub username.
 * @param projectPath - Optional project path; when given, resolves the username
 *   for that project's workspace login rather than the globally-active one, so
 *   it matches the account a repo created from that project lands under.
 * @returns GitHub username
 * @throws If not authenticated
 */
export async function getGitHubUsername(projectPath?: string): Promise<string> {
  return invoke<string>('get_github_username', { projectPath });
}

/**
 * Get list of GitHub organizations the user belongs to.
 * @param projectPath - Optional project path; scopes the org list to that
 *   project's workspace login (see {@link getGitHubUsername}).
 * @returns Array of organization names
 */
export async function getGitHubOrgs(projectPath?: string): Promise<string[]> {
  return invoke<string[]>('get_github_orgs', { projectPath });
}

/**
 * Get a project's GitHub repository status.
 * @param projectPath - Absolute path to the project directory
 * @returns Repository connection status
 */
export async function getProjectGitHubStatus(projectPath: string): Promise<ProjectGitHubStatus> {
  return invoke<ProjectGitHubStatus>('get_project_github_status', { projectPath });
}

/** Options for pushing a project to GitHub */
interface PushToGitHubOptions {
  /** Absolute path to the project directory */
  projectPath: string;
  /** Name for the GitHub repository */
  repoName: string;
  /** Whether to create a private repository */
  isPrivate: boolean;
}

/** GitHub repository primary language */
interface GitHubLanguage {
  name: string;
}

/** GitHub repository info from gh CLI */
export interface GitHubRepo {
  /** Repository name */
  name: string;
  /** HTTPS URL */
  url: string;
  /** SSH URL for cloning */
  sshUrl: string;
  /** Whether the repo is private */
  isPrivate: boolean;
  /** Repository description */
  description: string | null;
  /** Primary programming language */
  primaryLanguage: GitHubLanguage | null;
  /** Last updated timestamp */
  updatedAt: string;
}

/**
 * Create a GitHub repository and push the project.
 * @param options - Push configuration
 * @returns URL of the created repository
 */
export async function pushToGitHub(options: PushToGitHubOptions): Promise<string> {
  return invoke<string>('push_to_github', { options });
}

/**
 * List GitHub repositories for a given owner (user or organization).
 * @param owner - GitHub username or organization name
 * @returns Array of repository information
 */
export async function listGitHubRepos(owner: string): Promise<GitHubRepo[]> {
  return invoke<GitHubRepo[]>('list_github_repos', { owner });
}

/**
 * List GitHub repositories where the user is a collaborator (not owner).
 * These are repos owned by others where the user has been granted access.
 * @returns Array of repository information (name includes owner, e.g., "owner/repo")
 */
export async function listCollaboratorRepos(): Promise<GitHubRepo[]> {
  return invoke<GitHubRepo[]>('list_collaborator_repos');
}

/**
 * Detect the package manager used in a project.
 * Checks lock files first (pnpm, yarn, bun); with none committed, falls back to
 * what package.json declares (`packageManager`, `workspace:`/`catalog:` deps) or
 * a pnpm-workspace.yaml, then npm. When that manager isn't installed, the
 * first installed of npm → pnpm → bun → yarn is returned instead — Node isn't
 * required, so npm may not exist.
 * @param projectPath - Absolute path to the project directory
 * @returns Package manager name ("pnpm", "yarn", "bun", or "npm")
 */
export async function detectPackageManager(projectPath: string): Promise<string> {
  return invoke<string>('detect_package_manager', { projectPath });
}
