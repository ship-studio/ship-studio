/**
 * Code browser functions for exploring project files.
 *
 * Wraps Tauri commands for listing project files (respecting .gitignore)
 * and reading individual file contents with language detection.
 *
 * @module lib/code
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * Extract a file extension for analytics. Returns the trailing extension
 * (lowercase, no dot) when the basename contains a dot AFTER the first
 * character, otherwise an empty string. Avoids classifying `Dockerfile` as
 * extension `Dockerfile` and `.gitignore` as `gitignore`.
 */
export function fileExtensionForAnalytics(path: string): string {
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return ''; // no dot, or only a leading dot (`.gitignore`)
  return base.slice(dot + 1).toLowerCase();
}

/** A file or directory entry from the backend. */
export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
}

/** Content of a single file with viewer metadata. */
export interface FileContent {
  content: string;
  isBinary: boolean;
  isTruncated: boolean;
  size: number;
  language: string;
}

/** A node in the nested file tree structure. */
export interface FileTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  children: FileTreeNode[];
}

/** List all project files respecting .gitignore. */
export async function listProjectFiles(projectPath: string): Promise<FileEntry[]> {
  const entries = await invoke<
    Array<{
      name: string;
      path: string;
      is_directory: boolean;
      size: number;
    }>
  >('list_project_files', { projectPath });

  return entries.map((e) => ({
    name: e.name,
    path: e.path,
    isDirectory: e.is_directory,
    size: e.size,
  }));
}

/** Read a single file's content with binary/size checks. */
export async function readProjectFile(projectPath: string, filePath: string): Promise<FileContent> {
  const result = await invoke<{
    content: string;
    is_binary: boolean;
    is_truncated: boolean;
    size: number;
    language: string;
  }>('read_project_file', { projectPath, filePath });

  return {
    content: result.content,
    isBinary: result.is_binary,
    isTruncated: result.is_truncated,
    size: result.size,
    language: result.language,
  };
}

/**
 * How to resolve a name collision when moving/importing into a folder. `'error'`
 * surfaces the collision so the caller can prompt the user; `'replace'` and
 * `'rename'` resolve it. "Skip" is a frontend-only choice (just don't call, or
 * omit that source from an import) — there is no `'skip'` backend value.
 */
export type ConflictResolution = 'error' | 'replace' | 'rename';

/**
 * Move/relocate a file or directory within the project tree. Git-aware
 * (preserves tracking for tracked sources via `git mv`). Paths are
 * project-relative; `toDirRel === ''` is the project root. With
 * `onConflict: 'error'` (default) a name collision rejects with a `Validation`
 * error tagged `field: 'destination'` — the caller catches that to prompt
 * Rename/Replace/Skip. (A separate `field: 'symlink'` Validation error means a
 * hard refusal to overwrite a symlink, NOT a re-promptable collision.) Returns
 * the new project-relative path.
 */
export async function moveProjectEntry(
  projectPath: string,
  fromRel: string,
  toDirRel: string,
  onConflict: ConflictResolution = 'error'
): Promise<string> {
  return invoke<string>('move_project_entry', {
    projectPath,
    fromRel,
    toDirRel,
    onConflict,
  });
}

/** Per-source result of an import (mirrors the Rust `ImportOutcome`). */
export interface ImportOutcome {
  /** The input source path, echoed back for correlation. */
  source: string;
  /** `'imported'` — copied in; `'conflict'` — name already taken (not written). */
  status: 'imported' | 'conflict';
  /** New project-relative path; present only when `status === 'imported'`. */
  newRel: string | null;
  /** Whether the source is a directory. */
  isDir: boolean;
}

/**
 * Import (copy) files/folders from arbitrary OS locations into a project folder
 * — the backend for dragging from Finder onto the tree. `sources` are absolute
 * OS paths; `toDirRel` is project-relative (`''` = root). With the default
 * `onConflict: 'error'`, colliding sources come back as `status: 'conflict'`
 * (nothing written) rather than throwing, so the caller can prompt the user per
 * file and re-import the unresolved ones with `'replace'`/`'rename'` (or omit
 * them = Skip). Returns one outcome per source, in input order.
 */
export async function importPathsToProject(
  projectPath: string,
  sources: string[],
  toDirRel: string,
  onConflict: ConflictResolution = 'error'
): Promise<ImportOutcome[]> {
  return invoke<ImportOutcome[]>('import_paths_to_project', {
    projectPath,
    sources,
    toDirRel,
    onConflict,
  });
}

/**
 * Delete a file or directory from the project. The entry is moved to the OS
 * Trash / Recycle Bin (recoverable), not permanently unlinked. `rel` is
 * project-relative; deleting the project root, traversal paths, and missing
 * entries are rejected by the backend with a `Validation` error.
 */
export async function deleteProjectEntry(projectPath: string, rel: string): Promise<void> {
  await invoke('delete_project_entry', { projectPath, rel });
}

/** Overwrite a project file with new content (Code tab inline editor). */
export async function saveProjectFile(
  projectPath: string,
  filePath: string,
  content: string
): Promise<void> {
  await invoke('save_project_file', { projectPath, filePath, content });
}

/** Build a nested tree structure from a flat list of file entries. */
export function buildFileTree(entries: FileEntry[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const dirMap = new Map<string, FileTreeNode>();

  // Sort entries so directories come before their children
  const sorted = [...entries].sort((a, b) => {
    const aParts = a.path.split('/').length;
    const bParts = b.path.split('/').length;
    if (aParts !== bParts) return aParts - bParts;
    return a.path.localeCompare(b.path);
  });

  for (const entry of sorted) {
    const node: FileTreeNode = {
      name: entry.name,
      path: entry.path,
      isDirectory: entry.isDirectory,
      size: entry.size,
      children: [],
    };

    if (entry.isDirectory) {
      dirMap.set(entry.path, node);
    }

    // Find parent directory
    const lastSlash = entry.path.lastIndexOf('/');
    if (lastSlash === -1) {
      // Top-level entry
      root.push(node);
    } else {
      const parentPath = entry.path.substring(0, lastSlash);
      const parent = dirMap.get(parentPath);
      if (parent) {
        parent.children.push(node);
      } else {
        // Orphan — parent wasn't in the list, add to root
        root.push(node);
      }
    }
  }

  // Sort each level: directories first, then alphabetical
  const sortNodes = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    for (const node of nodes) {
      if (node.children.length > 0) {
        sortNodes(node.children);
      }
    }
  };

  sortNodes(root);
  return root;
}
