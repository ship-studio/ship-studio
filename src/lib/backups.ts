/**
 * Backup management functions for Harbr.
 *
 * Provides a user-friendly interface over git commits as "backups".
 *
 * @module lib/backups
 */

import { invoke } from '@tauri-apps/api/core';

/** A backup entry representing a git commit */
export interface Backup {
  /** Git commit hash (short form) */
  hash: string;
  /** Full commit hash */
  full_hash: string;
  /** Commit message */
  message: string;
  /** Unix timestamp (seconds) when the commit was made */
  timestamp: number;
  /** Relative time string (e.g., "2 hours ago") */
  relative_time: string;
}

/** Result of restoring a backup */
export interface RestoreResult {
  /** The name of the new branch created for the restore */
  branch_name: string;
  /** The commit message used for the restore commit */
  commit_message: string;
}

/**
 * Get list of backups (git commits) for a project.
 *
 * @param projectPath - Path to the project
 * @param limit - Maximum number of backups to return (default: 50)
 * @returns Array of backup entries
 */
export async function getBackups(projectPath: string, limit?: number): Promise<Backup[]> {
  return invoke<Backup[]>('get_backups', { projectPath, limit });
}

/**
 * Restore to a specific backup.
 *
 * This will:
 * 1. Create a new branch named "restore-{short-hash}"
 * 2. Restore files from the target backup
 * 3. Commit the restored state
 * 4. Push the new branch to remote
 *
 * The user must then create a PR and merge it to make the restore go live.
 *
 * @param projectPath - Path to the project
 * @param commitHash - The commit hash to restore to
 * @returns The restore result with branch name and commit message
 */
export async function restoreBackup(
  projectPath: string,
  commitHash: string
): Promise<RestoreResult> {
  return invoke<RestoreResult>('restore_backup', { projectPath, commitHash });
}
