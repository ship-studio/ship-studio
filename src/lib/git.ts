/**
 * Git operations wrapper for Tauri backend.
 *
 * Provides TypeScript types and functions for interacting with
 * git status and change detection.
 *
 * @module lib/git
 */

import { invoke } from '@tauri-apps/api/core';

/** Status type for a changed file */
export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed';

/** A file with uncommitted changes */
export interface ChangedFile {
  /** Relative file path from project root */
  path: string;
  /** Change type */
  status: ChangeStatus;
}

/**
 * Gets list of files with uncommitted changes in a project.
 *
 * Uses `git status --porcelain -uno` to get changed tracked files.
 *
 * @param projectPath - Absolute path to the project
 * @returns Array of changed files with their status
 */
export async function getChangedFiles(projectPath: string): Promise<ChangedFile[]> {
  return invoke<ChangedFile[]>('get_changed_files', { projectPath });
}
