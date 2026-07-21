/**
 * Git worktree management utilities.
 *
 * Thin wrappers over the backend `git worktree` commands. The feature surfaces
 * native git semantics: the list mirrors `git worktree list` (main worktree
 * included), removal keeps the branch, and prune clears stale entries.
 *
 * @module lib/worktrees
 */

import { invoke } from '@tauri-apps/api/core';

/** One entry from `git worktree list` */
export interface WorktreeInfo {
  /** Absolute path of the worktree directory */
  path: string;
  /** Short commit sha of the checked-out HEAD */
  head: string;
  /** Branch name (refs/heads/ stripped); null when detached */
  branch: string | null;
  /** True for the repository's main worktree */
  isMain: boolean;
  /** True when this entry is the directory the query was made from */
  isCurrent: boolean;
  /** Lock reason when locked (empty string if locked without a reason) */
  locked: string | null;
  /** Prune reason when git considers the entry stale */
  prunable: string | null;
}

export interface AddWorktreeOptions {
  /** Branch to check out in the new worktree */
  branch: string;
  /** Create the branch (from baseRef or HEAD) instead of checking out an existing one */
  createBranch: boolean;
  /** Base ref for a newly created branch (defaults to HEAD when omitted) */
  baseRef?: string;
  /** Copy the parent's untracked root .env* files into the worktree */
  copyEnv: boolean;
}

export interface AddWorktreeResult {
  /** Absolute path of the created worktree */
  path: string;
  /** Dev-server port persisted into the worktree's metadata, if one was free */
  port: number | null;
}

interface RawWorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
  is_main: boolean;
  is_current: boolean;
  locked: string | null;
  prunable: string | null;
}

/**
 * List all worktrees of the repository containing the project, main worktree
 * first. Returns an empty array for non-git projects.
 */
export async function listWorktrees(projectPath: string): Promise<WorktreeInfo[]> {
  const result = await invoke<RawWorktreeInfo[]>('list_worktrees', { projectPath });
  return result.map((w) => ({
    path: w.path,
    head: w.head,
    branch: w.branch,
    isMain: w.is_main,
    isCurrent: w.is_current,
    locked: w.locked,
    prunable: w.prunable,
  }));
}

/**
 * Create a worktree under `~/ShipStudio/.worktrees/<project>/<branch>` and
 * seed its Ship Studio metadata (dev command, monorepo subpath, distinct port).
 */
export async function addWorktree(
  projectPath: string,
  options: AddWorktreeOptions
): Promise<AddWorktreeResult> {
  return invoke<AddWorktreeResult>('add_worktree', {
    projectPath,
    branch: options.branch,
    createBranch: options.createBranch,
    baseRef: options.baseRef ?? null,
    copyEnv: options.copyEnv,
  });
}

/**
 * Remove a linked worktree (`git worktree remove`). Git refuses dirty trees
 * unless `force` — the rejection surfaces as a Process error whose stderr
 * explains why. The branch is kept, matching git.
 */
export async function removeWorktree(
  projectPath: string,
  worktreePath: string,
  force = false
): Promise<void> {
  return invoke<void>('remove_worktree', { projectPath, worktreePath, force });
}

/** Clear worktree entries whose directories no longer exist (`git worktree prune`). */
export async function pruneWorktrees(projectPath: string): Promise<void> {
  return invoke<void>('prune_worktrees', { projectPath });
}

/**
 * Frontend mirror of the backend folder sanitizer (`sanitize_worktree_folder`
 * in `src-tauri/src/commands/git/worktree.rs`) — used only to preview the
 * destination path; the backend computes the real one.
 */
export function worktreeFolderName(branch: string): string {
  let out = branch
    .replace(/[/\\]/g, '-')
    .replace(/[:*?"<>|]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, '');
  out = out
    .replace(/^[-.]+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 64);
  return out || 'worktree';
}

/** True when a path lives inside a Ship Studio-managed `.worktrees` container. */
export function isManagedWorktreePath(path: string): boolean {
  return path.includes('/.worktrees/') || path.includes('\\.worktrees\\');
}
