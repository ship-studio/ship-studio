/**
 * Merge conflict resolution utilities.
 *
 * Provides functions for detecting, resolving, and managing
 * git merge conflicts through the Tauri backend.
 *
 * @module lib/conflicts
 */

import { invoke } from '@tauri-apps/api/core';

/** A single conflict block within a file */
export interface ConflictBlock {
  lineStart: number;
  lineEnd: number;
  currentContent: string; // Between <<<<<<< and =======
  incomingContent: string; // Between ======= and >>>>>>>
  contextBefore: string; // 3 lines before conflict
  contextAfter: string; // 3 lines after conflict
}

/** Information about a file with conflicts */
export interface ConflictedFile {
  filePath: string;
  isBinary: boolean;
  conflicts: ConflictBlock[];
  oursBranch: string;
  theirsBranch: string;
}

/**
 * Get information about all conflicted files in the repository.
 * Parses conflict markers and extracts content for each side.
 */
export async function getConflictInfo(projectPath: string): Promise<ConflictedFile[]> {
  const result = await invoke<
    Array<{
      file_path: string;
      is_binary: boolean;
      conflicts: Array<{
        line_start: number;
        line_end: number;
        current_content: string;
        incoming_content: string;
        context_before: string;
        context_after: string;
      }>;
      ours_branch: string;
      theirs_branch: string;
    }>
  >('get_conflict_info', { projectPath });

  // Transform snake_case to camelCase
  return result.map((file) => ({
    filePath: file.file_path,
    isBinary: file.is_binary,
    conflicts: file.conflicts.map((c) => ({
      lineStart: c.line_start,
      lineEnd: c.line_end,
      currentContent: c.current_content,
      incomingContent: c.incoming_content,
      contextBefore: c.context_before,
      contextAfter: c.context_after,
    })),
    oursBranch: file.ours_branch,
    theirsBranch: file.theirs_branch,
  }));
}

/**
 * Resolve a single conflict by choosing current or incoming content.
 * If no more conflicts remain in the file, it will be staged automatically.
 */
export async function resolveConflict(
  projectPath: string,
  filePath: string,
  conflictIndex: number,
  resolution: 'current' | 'incoming'
): Promise<void> {
  await invoke('resolve_conflict', {
    projectPath,
    filePath,
    conflictIndex,
    resolution,
  });
}

/**
 * Abort the current merge and return to pre-merge state.
 */
export async function abortMerge(projectPath: string): Promise<void> {
  await invoke('abort_merge', { projectPath });
}

/**
 * Complete the merge after all conflicts have been resolved.
 * Creates a commit with message "Resolved merge conflicts via Ship Studio".
 */
export async function completeMerge(projectPath: string): Promise<void> {
  await invoke('complete_merge', { projectPath });
}
