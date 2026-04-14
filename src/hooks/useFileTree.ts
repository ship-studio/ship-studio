/**
 * Hook for managing file tree state in the code browser.
 *
 * Handles loading the file tree, expanding/collapsing directories,
 * selecting files, and lazy-loading file content on demand.
 *
 * @module hooks/useFileTree
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  listProjectFiles,
  readProjectFile,
  buildFileTree,
  type FileTreeNode,
  type FileContent,
} from '../lib/code';
import { logger } from '../lib/logger';
import { useAsyncState } from './useAsyncState';

interface UseFileTreeResult {
  tree: FileTreeNode[];
  expandedPaths: Set<string>;
  selectedFilePath: string | null;
  fileContent: FileContent | null;
  isLoadingTree: boolean;
  isLoadingFile: boolean;
  treeError: string | null;
  fileError: string | null;
  toggleDirectory: (path: string) => void;
  selectFile: (path: string) => void;
  refreshTree: () => void;
}

export function useFileTree(projectPath: string): UseFileTreeResult {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const selectedFileRef = useRef(selectedFilePath);
  useEffect(() => {
    selectedFileRef.current = selectedFilePath;
  }, [selectedFilePath]);

  const fetchTree = useCallback(async (path: string) => {
    try {
      const entries = await listProjectFiles(path);
      return buildFileTree(entries);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to load file tree', { error: msg });
      throw err;
    }
  }, []);
  const {
    data: treeData,
    isLoading: isLoadingTree,
    error: treeErrorObj,
    execute: executeLoadTree,
  } = useAsyncState<FileTreeNode[], [string]>(fetchTree, { initial: [] });
  const tree = treeData ?? [];
  const treeError = treeErrorObj ? treeErrorObj.message : null;

  const fetchFile = useCallback(async (proj: string, path: string) => {
    try {
      return await readProjectFile(proj, path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to read file', { path, error: msg });
      throw err;
    }
  }, []);
  const fileState = useAsyncState<FileContent, [string, string]>(fetchFile);
  const {
    data: fileContent,
    isLoading: isLoadingFile,
    error: fileErrorObj,
    execute: executeLoadFile,
    setData: setFileContent,
    reset: resetFile,
  } = fileState;
  // Clear fileContent when execute fails (matches previous behavior)
  const executeLoadFileAndClear = useCallback(
    async (proj: string, path: string) => {
      const result = await executeLoadFile(proj, path);
      if (result === null) {
        // Error occurred — clear stale content
        setFileContent(null);
      }
      return result;
    },
    [executeLoadFile, setFileContent]
  );
  const fileError = fileErrorObj ? fileErrorObj.message : null;

  // Reset state when project changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: reset UI state when project changes
    setSelectedFilePath(null);
    setFileContent(null);
    resetFile();
    setExpandedPaths(new Set());
  }, [projectPath, setFileContent, resetFile]);

  const loadTree = useCallback(() => executeLoadTree(projectPath), [executeLoadTree, projectPath]);

  // Load tree on mount / project change
  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  const toggleDirectory = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const selectFile = useCallback(
    async (path: string) => {
      if (path === selectedFileRef.current) return;
      setSelectedFilePath(path);
      await executeLoadFileAndClear(projectPath, path);
    },
    [projectPath, executeLoadFileAndClear]
  );

  const refreshTree = useCallback(() => {
    void loadTree();
  }, [loadTree]);

  return {
    tree,
    expandedPaths,
    selectedFilePath,
    fileContent,
    isLoadingTree,
    isLoadingFile,
    treeError,
    fileError,
    toggleDirectory,
    selectFile: (path: string) => void selectFile(path),
    refreshTree,
  };
}
