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
  /** Whether the branch exists on GitHub (origin/<name>) vs local-only */
  pushed: boolean;
}

/** Result of switching branches */
export interface SwitchResult {
  /** Whether the switch was successful */
  success: boolean;
  /** Whether changes were stashed */
  stashedChanges: boolean;
  /** When switching to a branch that has a pending stash, the source branch name */
  pendingStashFrom: string | null;
  /** Whether a stash was automatically applied during the switch */
  stashApplied: boolean;
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
      pushed: boolean;
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
    pushed: b.pushed,
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
    pending_stash_from: string | null;
    stash_applied: boolean;
    error: string | null;
  }>('switch_branch', { projectPath, branchName, autoStash });

  return {
    success: result.success,
    stashedChanges: result.stashed_changes,
    pendingStashFrom: result.pending_stash_from,
    stashApplied: result.stash_applied,
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
 * Byte cap for sanitized branch names. GitHub rejects refs longer than 255
 * bytes (`GH005: Sorry, refs longer than 255 bytes are not allowed.`), and the
 * limit applies to the full `refs/heads/<name>` string — auto-generated names
 * derived from free text (task/issue descriptions) blew past it and the push
 * failure was misreported as a push race (issue #636). 120 leaves generous
 * headroom for the `refs/heads/` prefix and any `user/`-style namespacing a
 * caller prepends.
 */
const MAX_BRANCH_NAME_BYTES = 120;

/**
 * Sanitize user input into a valid git branch name.
 *
 * Rather than rejecting names like "adjust h2", we normalize them into
 * something git accepts ("adjust-h2"):
 * - trims and collapses whitespace runs into a single `-`
 * - strips characters invalid in git refs (`~ ^ : ? * [ ] \` and `@{`)
 * - collapses `..` runs into a single `.`
 * - collapses repeated `-` / `/`
 * - strips leading `-`, `/` and `.`, trailing `/` and `.`, and a trailing `.lock`
 * - caps the result at {@link MAX_BRANCH_NAME_BYTES} bytes (GitHub's ref limit
 *   is 255 bytes; free-text-derived names could exceed it — issue #636)
 *
 * An input with nothing salvageable returns an empty string — callers must
 * treat that the same as an empty input.
 *
 * @param name - Raw user input
 * @returns A git-safe branch name, or an empty string
 */
export function sanitizeBranchName(name: string): string {
  let sanitized = name
    .trim()
    .replace(/\s+/g, '-') // whitespace runs → single dash
    // eslint-disable-next-line no-control-regex
    .replace(/[~^:?*[\]\\\x00-\x1f\x7f]/g, '') // chars git forbids in refs
    .replace(/@\{/g, '') // "@{" sequence is invalid in refs
    .replace(/\.\.+/g, '.') // ".." is invalid in refs
    .replace(/-+/g, '-') // collapse repeated dashes
    .replace(/\/+/g, '/'); // collapse repeated slashes

  // Cap the byte length (git ref limits are in bytes, not characters).
  // Truncate on the encoded bytes, then drop any replacement character left
  // by cutting a multi-byte sequence in half.
  if (new TextEncoder().encode(sanitized).length > MAX_BRANCH_NAME_BYTES) {
    const bytes = new TextEncoder().encode(sanitized).slice(0, MAX_BRANCH_NAME_BYTES);
    sanitized = new TextDecoder().decode(bytes).replace(/�+$/, '');
  }

  // Stripping one thing can expose another (e.g. "name..lock" → "name.lock"
  // → "name"), so repeat until stable. Also tidies whatever the byte cap cut
  // mid-word (a trailing `-`/`/`/`.` left at the cut point).
  for (;;) {
    const next = sanitized
      .replace(/^[-/.]+/, '') // leading dashes/slashes/dots (git rejects leading "-")
      .replace(/[-/.]+$/, '') // trailing dashes/slashes/dots
      .replace(/\.lock$/, ''); // git refuses refs ending in ".lock"
    if (next === sanitized) break;
    sanitized = next;
  }

  return sanitized;
}

/**
 * Create a new branch from a base branch.
 * @param projectPath - Absolute path to the project directory
 * @param branchName - Name for the new branch
 * @param fromBranch - Base branch to create from (e.g., "main" or "develop")
 */
export async function createBranch(
  projectPath: string,
  branchName: string,
  fromBranch: string
): Promise<void> {
  return invoke('create_branch', { projectPath, branchName, fromBranch });
}

/** A branch and its fork parent, for the branch-graph visual. */
export interface BranchGraphNode {
  /** Branch name (without origin/ prefix) */
  name: string;
  /** Branch this one was forked from; null for a root branch (e.g. main). */
  base: string | null;
  /** Whether this is the currently checked out branch */
  isCurrent: boolean;
  /** Whether this is the project's default/base branch */
  isDefault: boolean;
  /** Whether this branch only exists on remote */
  isRemote: boolean;
  /** Commits this branch is ahead of its base */
  ahead: number;
  /** Commits this branch is behind its base */
  behind: number;
  /** Unix timestamp (ms) of last commit */
  lastCommitDate: number;
  /** Whether the branch exists on GitHub (origin/<name>) vs local-only */
  pushed: boolean;
}

/** The rendered branch-graph subset plus the true branch count. */
export interface BranchGraphResult {
  nodes: BranchGraphNode[];
  /** Total branches in the repo — may exceed nodes.length when trimmed. */
  totalBranches: number;
}

/**
 * Build the branch-graph node list (branches + fork lineage + ahead/behind).
 * Local git only — no network. PR arrows are overlaid by the caller from its
 * existing (workspace-scoped) open-PR list.
 * @param projectPath - Absolute path to the project directory
 * @param limit - Cap on rendered branches (current + default always included)
 */
export async function getBranchGraph(
  projectPath: string,
  limit?: number
): Promise<BranchGraphResult> {
  const result = await invoke<{
    nodes: Array<{
      name: string;
      base: string | null;
      is_current: boolean;
      is_default: boolean;
      is_remote: boolean;
      ahead: number;
      behind: number;
      last_commit_date: number;
      pushed: boolean;
    }>;
    total_branches: number;
  }>('get_branch_graph', { projectPath, limit: limit ?? null });

  return {
    totalBranches: result.total_branches,
    nodes: result.nodes.map((n) => ({
      name: n.name,
      base: n.base,
      isCurrent: n.is_current,
      isDefault: n.is_default,
      isRemote: n.is_remote,
      ahead: n.ahead,
      behind: n.behind,
      lastCommitDate: n.last_commit_date,
      pushed: n.pushed,
    })),
  };
}

/**
 * Publish a single branch to GitHub without opening a PR (`git push -u origin`).
 * @param projectPath - Absolute path to the project directory
 * @param branchName - Local branch to push
 */
export async function pushBranch(projectPath: string, branchName: string): Promise<void> {
  return invoke('push_branch', { projectPath, branchName });
}

/**
 * Get the project's default base branch — the branch new branches are cut from
 * and PRs merge into by default. Falls back to the repo's conventional default
 * (main/master) when unset. May be null if none can be determined.
 * @param projectPath - Absolute path to the project directory
 */
export async function getDefaultBaseBranch(projectPath: string): Promise<string | null> {
  return invoke<string | null>('get_default_base_branch', { projectPath });
}

/**
 * Set (or clear, with null) the project's default base branch.
 * @param projectPath - Absolute path to the project directory
 * @param branch - Branch name, or null to clear back to the repo default
 */
export async function setDefaultBaseBranch(
  projectPath: string,
  branch: string | null
): Promise<void> {
  return invoke('set_default_base_branch', { projectPath, branch });
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
  /** Whether the PR is a GitHub draft (drafts can't be merged) */
  isDraft: boolean;
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
      is_draft: boolean;
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
    isDraft: pr.is_draft,
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
 * Checkout a pull request branch locally for review.
 * @param projectPath - Absolute path to the project directory
 * @param prNumber - PR number to checkout
 * @returns The branch name that was checked out
 */
export async function checkoutPullRequest(projectPath: string, prNumber: number): Promise<string> {
  return invoke('checkout_pull_request', { projectPath, prNumber });
}

/**
 * Close a pull request without merging.
 * @param projectPath - Absolute path to the project directory
 * @param prNumber - PR number to close
 */
export async function closePullRequest(projectPath: string, prNumber: number): Promise<void> {
  return invoke('close_pull_request', { projectPath, prNumber });
}

/**
 * Pull remote changes and merge.
 * This can result in merge conflicts if local and remote changes overlap.
 * @param projectPath - Absolute path to the project directory
 * @param mergeBranch - Optional branch to merge (e.g., "main"). If not provided, pulls from upstream.
 * @returns Git's own summary output (e.g. "Already up to date." or merge/fast-forward stats)
 * @throws Error with MERGE_CONFLICT prefix if conflicts occur
 */
export async function pullAndMerge(projectPath: string, mergeBranch?: string): Promise<string> {
  return invoke<string>('pull_and_merge', { projectPath, mergeBranch });
}

/**
 * Get the branch name prefix preference for a project.
 * When enabled, new branches are prefixed with the GitHub username.
 * @param projectPath - Absolute path to the project directory
 * @returns Whether branch name prefixing is enabled
 */
export async function getBranchPrefixPreference(projectPath: string): Promise<boolean> {
  return invoke<boolean>('get_branch_prefix_preference', { projectPath });
}

/**
 * Set the branch name prefix preference for a project.
 * @param projectPath - Absolute path to the project directory
 * @param prefix - Whether to prefix new branch names with the GitHub username
 */
export async function setBranchPrefixPreference(
  projectPath: string,
  prefix: boolean
): Promise<void> {
  return invoke<void>('set_branch_prefix_preference', { projectPath, prefix });
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
