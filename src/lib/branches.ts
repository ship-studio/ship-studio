/**
 * Branch management utilities.
 *
 * Provides functions for:
 * - Listing all branches (local and remote)
 * - Switching between branches
 * - Creating new branches
 * - Publishing branches to remote
 * - Deleting branches
 *
 * @module lib/branches
 */

import { invoke } from '@tauri-apps/api/core';

/** Information about a git branch */
export interface BranchInfo {
  /** Branch name (without origin/ prefix) */
  name: string;
  /** Whether this is the currently checked out branch */
  isCurrent: boolean;
  /** Whether this branch only exists on remote */
  isRemote: boolean;
  /** Whether this is main/master */
  isDefault: boolean;
  /** Unix timestamp (ms) of last commit */
  lastCommitDate: number;
  /** Author of last commit */
  lastCommitAuthor: string;
  /** Number of commits ahead of main */
  aheadOfMain: number;
  /** Number of commits behind main */
  behindOfMain: number;
}

/** Result of switching branches */
export interface SwitchResult {
  /** Whether the switch was successful */
  success: boolean;
  /** Whether changes were stashed */
  stashedChanges: boolean;
  /** Error message if switch failed */
  error: string | null;
}

/** Result of a publish operation */
export interface PublishResult {
  /** Deployment URL (may be empty initially) */
  url: string;
  /** Deployment state */
  state: string;
}

/**
 * List all branches (local and remote) with metadata.
 * @param projectPath - Absolute path to the project directory
 * @returns Array of branch info objects
 */
export async function listBranches(projectPath: string): Promise<BranchInfo[]> {
  const result = await invoke<
    Array<{
      name: string;
      is_current: boolean;
      is_remote: boolean;
      is_default: boolean;
      last_commit_date: number;
      last_commit_author: string;
      ahead_of_main: number;
      behind_main: number;
    }>
  >('list_branches', { projectPath });

  // Transform snake_case to camelCase
  return result.map((b) => ({
    name: b.name,
    isCurrent: b.is_current,
    isRemote: b.is_remote,
    isDefault: b.is_default,
    lastCommitDate: b.last_commit_date,
    lastCommitAuthor: b.last_commit_author,
    aheadOfMain: b.ahead_of_main,
    behindOfMain: b.behind_main,
  }));
}

/**
 * Get the current branch name.
 * @param projectPath - Absolute path to the project directory
 * @returns Current branch name
 */
export async function getCurrentBranch(projectPath: string): Promise<string> {
  return invoke<string>('get_current_branch', { projectPath });
}

/**
 * Switch to a different branch.
 * @param projectPath - Absolute path to the project directory
 * @param branchName - Name of the branch to switch to
 * @param autoStash - Whether to automatically stash uncommitted changes
 * @returns Result with success status and any errors
 */
export async function switchBranch(
  projectPath: string,
  branchName: string,
  autoStash = true
): Promise<SwitchResult> {
  const result = await invoke<{
    success: boolean;
    stashed_changes: boolean;
    error: string | null;
  }>('switch_branch', { projectPath, branchName, autoStash });

  return {
    success: result.success,
    stashedChanges: result.stashed_changes,
    error: result.error,
  };
}

/**
 * Discard all uncommitted changes in the working directory.
 * This removes changes to tracked files and deletes untracked files.
 * @param projectPath - Absolute path to the project directory
 */
export async function discardChanges(projectPath: string): Promise<void> {
  return invoke('discard_changes', { projectPath });
}

/**
 * Create a new branch from a base branch.
 * @param projectPath - Absolute path to the project directory
 * @param branchName - Name for the new branch
 * @param fromBranch - Base branch to create from (e.g., "main")
 */
export async function createBranch(
  projectPath: string,
  branchName: string,
  fromBranch: string
): Promise<void> {
  return invoke('create_branch', { projectPath, branchName, fromBranch });
}

/**
 * Fetch all branches from all remotes.
 * @param projectPath - Absolute path to the project directory
 */
export async function fetchAllBranches(projectPath: string): Promise<void> {
  return invoke('fetch_all_branches', { projectPath });
}

/**
 * Publish (push) the current branch to origin.
 * Commits any uncommitted changes before pushing.
 * @param projectPath - Absolute path to the project directory
 * @param commitMessage - Optional commit message
 * @returns Publish result
 */
export async function publishBranch(
  projectPath: string,
  commitMessage?: string
): Promise<PublishResult> {
  return invoke<PublishResult>('publish_branch', { projectPath, commitMessage });
}

/** Deployment status from Vercel */
export interface DeploymentStatus {
  /** Deployment state: BUILDING, READY, ERROR, QUEUED, CANCELED */
  state: string;
  /** Deployment URL */
  url: string | null;
  /** Unix timestamp (ms) when deployment was created */
  createdAt: number | null;
  /** Unix timestamp (ms) when deployment became ready */
  readyAt: number | null;
}

/**
 * Get the latest deployment status from Vercel.
 *
 * Uses `vercel ls` to find the latest deployment, then `vercel inspect --json`
 * to get accurate status. The optional `sinceTimestamp` parameter filters out
 * deployments created before that time - useful for tracking a newly triggered deployment.
 *
 * @param projectPath - Absolute path to the project directory
 * @param sinceTimestamp - Optional Unix timestamp (ms) to filter old deployments
 * @returns Deployment status or null if unavailable
 */
export async function getDeploymentStatus(
  projectPath: string,
  sinceTimestamp?: number
): Promise<DeploymentStatus | null> {
  return invoke<DeploymentStatus | null>('get_deployment_status', {
    projectPath,
    sinceTimestamp: sinceTimestamp ?? null,
  });
}

/**
 * Delete a branch.
 * @param projectPath - Absolute path to the project directory
 * @param branchName - Name of the branch to delete
 * @param deleteRemote - Whether to also delete the remote branch
 */
export async function deleteBranch(
  projectPath: string,
  branchName: string,
  deleteRemote = false
): Promise<void> {
  return invoke('delete_branch', { projectPath, branchName, deleteRemote });
}

/** Information about a pull request */
export interface PullRequestInfo {
  /** PR number */
  number: number;
  /** PR title */
  title: string;
  /** Source branch */
  headRef: string;
  /** Target branch */
  baseRef: string;
  /** Author username */
  author: string;
  /** PR state (OPEN, CLOSED, MERGED) */
  state: string;
  /** Whether the PR can be merged */
  mergeable: boolean | null;
  /** URL to the PR on GitHub */
  url: string;
  /** ISO timestamp of creation */
  createdAt: string;
}

/**
 * List pull requests for the repository.
 * @param projectPath - Absolute path to the project directory
 * @returns Array of pull request info
 */
export async function listPullRequests(projectPath: string): Promise<PullRequestInfo[]> {
  const result = await invoke<
    Array<{
      number: number;
      title: string;
      head_ref: string;
      base_ref: string;
      author: string;
      state: string;
      mergeable: boolean | null;
      url: string;
      created_at: string;
    }>
  >('list_pull_requests', { projectPath });

  return result.map((pr) => ({
    number: pr.number,
    title: pr.title,
    headRef: pr.head_ref,
    baseRef: pr.base_ref,
    author: pr.author,
    state: pr.state,
    mergeable: pr.mergeable,
    url: pr.url,
    createdAt: pr.created_at,
  }));
}

/**
 * Create a new pull request.
 * @param projectPath - Absolute path to the project directory
 * @param title - PR title
 * @param body - Optional PR description
 * @param base - Target branch (e.g., "main")
 * @returns URL of the created PR
 */
export async function createPullRequest(
  projectPath: string,
  title: string,
  body: string | null,
  base: string
): Promise<string> {
  return invoke<string>('create_pull_request', { projectPath, title, body, base });
}

/**
 * Merge a pull request.
 * @param projectPath - Absolute path to the project directory
 * @param prNumber - Number of the PR to merge
 */
export async function mergePullRequest(projectPath: string, prNumber: number): Promise<void> {
  return invoke('merge_pull_request', { projectPath, prNumber });
}

/**
 * Pull remote changes and merge.
 * This can result in merge conflicts if local and remote changes overlap.
 * @param projectPath - Absolute path to the project directory
 * @param mergeBranch - Optional branch to merge (e.g., "main"). If not provided, pulls from upstream.
 * @throws Error with MERGE_CONFLICT prefix if conflicts occur
 */
export async function pullAndMerge(projectPath: string, mergeBranch?: string): Promise<void> {
  return invoke('pull_and_merge', { projectPath, mergeBranch });
}

/**
 * Format a relative time string from a timestamp.
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Human-readable relative time (e.g., "2 hours ago")
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return days === 1 ? 'yesterday' : `${days} days ago`;
  }
  if (hours > 0) {
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  if (minutes > 0) {
    return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  }
  return 'just now';
}
