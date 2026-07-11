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
