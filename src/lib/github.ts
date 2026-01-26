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
  /** Connection state */
  status: 'not-a-repo' | 'no-remote' | 'connected';
  /** Repository identifier (e.g., "username/repo-name") - only set if connected */
  github_repo: string | null;
  /** Full repository URL (e.g., "https://github.com/username/repo-name") - only set if connected */
  github_url: string | null;
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
 * @returns GitHub username
 * @throws If not authenticated
 */
export async function getGitHubUsername(): Promise<string> {
  return invoke<string>('get_github_username');
}

/**
 * Get list of GitHub organizations the user belongs to.
 * @returns Array of organization names
 */
export async function getGitHubOrgs(): Promise<string[]> {
  return invoke<string[]>('get_github_orgs');
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
export interface PushToGitHubOptions {
  /** Absolute path to the project directory */
  projectPath: string;
  /** Name for the GitHub repository */
  repoName: string;
  /** Whether to create a private repository */
  isPrivate: boolean;
}

/** GitHub repository primary language */
export interface GitHubLanguage {
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

/** Result of a publish operation */
interface PublishResult {
  /** Deployment URL */
  url: string;
  /** Deployment state (e.g., "READY", "BUILDING") */
  state: string;
}

/**
 * Publish current changes to the staging branch.
 * Commits and pushes to the staging branch, triggering Vercel preview deployment.
 * @param projectPath - Absolute path to the project directory
 * @returns Publish result with URL and state
 */
export async function publishToStaging(projectPath: string): Promise<PublishResult> {
  return invoke<PublishResult>('publish_to_staging', { projectPath });
}

/**
 * Publish current changes to production.
 * Merges staging into main and pushes, triggering Vercel production deployment.
 * @param projectPath - Absolute path to the project directory
 * @returns Publish result with URL and state
 */
export async function publishToProduction(projectPath: string): Promise<PublishResult> {
  return invoke<PublishResult>('publish_to_production', { projectPath });
}

/** Branch comparison status between local, staging, and main */
export interface BranchStatus {
  /** Whether there are uncommitted local changes */
  local_changes: boolean;
  /** Number of commits local is ahead of staging */
  staging_ahead: number;
  /** Number of commits local is behind staging */
  staging_behind: number;
  /** Number of commits local is ahead of main */
  main_ahead: number;
  /** Number of commits local is behind main */
  main_behind: number;
  /** Whether staging branch exists */
  staging_exists: boolean;
}

/**
 * Get branch comparison status for a project.
 * @param projectPath - Absolute path to the project directory
 * @returns Branch status with ahead/behind counts
 */
export async function getBranchStatus(projectPath: string): Promise<BranchStatus> {
  return invoke<BranchStatus>('get_branch_status', { projectPath });
}

/**
 * Reset local branch to match remote staging or production.
 * @param projectPath - Absolute path to the project directory
 * @param branch - Target branch ("staging" or "production")
 */
export async function resetToBranch(
  projectPath: string,
  branch: 'staging' | 'production'
): Promise<void> {
  return invoke('reset_to_branch', { projectPath, branch });
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
 * Detect the package manager used in a project.
 * Checks for lock files in the following order: pnpm, yarn, bun, npm (default).
 * @param projectPath - Absolute path to the project directory
 * @returns Package manager name ("pnpm", "yarn", "bun", or "npm")
 */
export async function detectPackageManager(projectPath: string): Promise<string> {
  return invoke<string>('detect_package_manager', { projectPath });
}
