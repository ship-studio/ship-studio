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
  saveProjectFile,
  buildFileTree,
  fileExtensionForAnalytics,
  type FileTreeNode,
  type FileContent,
} from '../lib/code';
import { logger } from '../lib/logger';
import { asCommandError, formatCommandError } from '../lib/errors';
import { trackEvent } from '../lib/analytics';
import { useAsyncState } from './useAsyncState';

/**
 * Global, persisted opt-in for Code-tab editing. When on, opening an editable
 * file drops straight into the editor (no per-file Edit click); when off the
 * Code tab is read-only. Stored app-wide (not per project) so the choice
 * survives project switches and restarts — mirrors the visual editor's
 * localStorage-persisted toggle.
 */
const CODE_EDIT_MODE_KEY = 'shipstudio:code-edit-mode';

/**
 * A pending action that would discard the current edit buffer and so needs a
 * discard confirmation first: switching to `path`, or turning Edit mode off.
 */
export type PendingFileAction = { kind: 'switch'; path: string } | { kind: 'disable-edit' } | null;

/** Outcome of a save attempt: written, nothing-to-write, or failed. */
export type SaveResult = 'saved' | 'noop' | 'error';

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
  // Inline editing of the selected file.
  isEditing: boolean;
  draft: string;
  isDirty: boolean;
  isSaving: boolean;
  saveError: string | null;
  cancelEdit: () => void;
  updateDraft: (value: string) => void;
  /** Persist the draft. Resolves 'saved', 'noop' (nothing to write), or 'error'. */
  saveFile: () => Promise<SaveResult>;
  /** Global, persisted "Code tab is editable" opt-in. */
  editModeEnabled: boolean;
  /** Toggle global edit mode (confirms first if it would drop unsaved edits). */
  setEditMode: (enabled: boolean) => void;
  /** A discard confirmation the UI must surface, or null. */
  pendingAction: PendingFileAction;
  /** Proceed with the pending action (discards the buffer). */
  confirmPendingAction: () => void;
  /** Dismiss the pending action, keeping the current buffer. */
  cancelPendingAction: () => void;
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

  // Inline edit state for the selected file.
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const isDirty = isEditing && fileContent != null && draft !== fileContent.content;
  // The file-switch guard reads dirtiness from a closure, so mirror it in a ref.
  const isDirtyRef = useRef(isDirty);
  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  // A discard-confirmation the UI must show before an action that would drop the
  // dirty buffer (switching files, or turning Edit mode off). Driven by an in-app
  // modal rather than window.confirm, which Tauri's webview overrides to return a
  // thenable — `!confirm(...)` is always false there, so it never blocks.
  const [pendingAction, setPendingAction] = useState<PendingFileAction>(null);

  const exitEdit = useCallback(() => {
    setIsEditing(false);
    setDraft('');
    setSaveError(null);
  }, []);

  // Reset state when project changes. Also drop any pending discard modal — a
  // stale 'switch' confirmation would otherwise run against the new project.
  useEffect(() => {
    setSelectedFilePath(null);
    setFileContent(null);
    resetFile();
    setExpandedPaths(new Set());
    setPendingAction(null);
    exitEdit();
  }, [projectPath, setFileContent, resetFile, exitEdit]);

  // Mirror the active project so an in-flight save can detect a switch and skip
  // committing its (now stale) buffer into the new viewer.
  const projectPathRef = useRef(projectPath);
  useEffect(() => {
    projectPathRef.current = projectPath;
  }, [projectPath]);

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

  // Load a file into the viewer, discarding any current edit buffer. The
  // unsaved-changes guard lives in the callers, not here.
  const loadFileIntoViewer = useCallback(
    async (path: string) => {
      exitEdit();
      setSelectedFilePath(path);
      // Clear stale content up front so the editor unmounts during the load and
      // remounts fresh on the new file. Without this the editor (keyed by path)
      // would remount over the PREVIOUS file's still-present buffer, and a
      // jump-to-code reveal would fire once against that stale content.
      setFileContent(null);
      await executeLoadFileAndClear(projectPath, path);
    },
    [projectPath, executeLoadFileAndClear, exitEdit, setFileContent]
  );

  const selectFile = useCallback(
    async (path: string) => {
      if (path === selectedFileRef.current) return;
      // Unsaved edits → confirm before discarding (via the in-app modal).
      if (isDirtyRef.current) {
        setPendingAction({ kind: 'switch', path });
        return;
      }
      await loadFileIntoViewer(path);
    },
    [loadFileIntoViewer]
  );

  const refreshTree = useCallback(() => {
    void loadTree();
  }, [loadTree]);

  const beginEdit = useCallback(() => {
    if (!fileContent || fileContent.isBinary || fileContent.isTruncated) return;
    setDraft(fileContent.content);
    setSaveError(null);
    setIsEditing(true);
  }, [fileContent]);

  // Global, persisted edit-mode opt-in (app-wide, not per project).
  const [editModeEnabled, setEditModeEnabled] = useState(() => {
    try {
      return localStorage.getItem(CODE_EDIT_MODE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const applyEditMode = useCallback(
    (enabled: boolean) => {
      setEditModeEnabled(enabled);
      try {
        localStorage.setItem(CODE_EDIT_MODE_KEY, enabled ? '1' : '0');
      } catch {
        /* localStorage unavailable — the toggle just won't persist */
      }
      if (!enabled) exitEdit();
    },
    [exitEdit]
  );

  const setEditMode = useCallback(
    (enabled: boolean) => {
      // Turning off while a buffer is dirty would drop the edits — confirm first.
      if (!enabled && isDirtyRef.current) {
        setPendingAction({ kind: 'disable-edit' });
        return;
      }
      applyEditMode(enabled);
    },
    [applyEditMode]
  );

  // Resolve the pending discard-confirmation: carry out the action the user was
  // blocked on (it discards the buffer), or just dismiss it.
  const confirmPendingAction = useCallback(() => {
    const action = pendingAction;
    setPendingAction(null);
    if (!action) return;
    if (action.kind === 'switch') {
      void loadFileIntoViewer(action.path);
    } else {
      applyEditMode(false);
    }
  }, [pendingAction, loadFileIntoViewer, applyEditMode]);

  const cancelPendingAction = useCallback(() => setPendingAction(null), []);

  // With global edit mode on, open editable files straight into the editor and
  // re-enter after each file switch. cancelEdit() flips isEditing off, so this
  // also re-seeds a fresh draft — i.e. Revert-to-saved. Skips binary/truncated
  // files (beginEdit guards those too), which stay read-only.
  useEffect(() => {
    if (
      editModeEnabled &&
      !isEditing &&
      fileContent != null &&
      !fileContent.isBinary &&
      !fileContent.isTruncated
    ) {
      beginEdit();
    }
  }, [editModeEnabled, isEditing, fileContent, beginEdit]);

  const saveFile = useCallback(async (): Promise<SaveResult> => {
    const path = selectedFileRef.current;
    const savingProjectPath = projectPath;
    // Nothing to write — viewing a file, or a clean buffer (also gates ⌘S).
    // Returns 'noop' (not 'error') so callers don't surface a false failure toast.
    if (!path || !isEditing || fileContent == null || draft === fileContent.content) {
      return 'noop';
    }
    setIsSaving(true);
    setSaveError(null);
    try {
      await saveProjectFile(savingProjectPath, path, draft);
      void trackEvent('code_file_saved', { file_extension: fileExtensionForAnalytics(path) });
      // The user may have switched project/file while the write was in flight —
      // committing the old buffer would corrupt the new viewer state. The bytes
      // are safely on disk; just skip the in-memory commit.
      if (projectPathRef.current !== savingProjectPath || selectedFileRef.current !== path) {
        return 'saved';
      }
      // Commit the buffer into fileContent so the read view reflects the save
      // and the dirty flag clears, without a round-trip re-read.
      setFileContent({
        ...fileContent,
        content: draft,
        size: new TextEncoder().encode(draft).length,
      });
      return 'saved';
    } catch (err) {
      const msg = formatCommandError(asCommandError(err));
      logger.error('Failed to save file', { path, error: msg });
      setSaveError(msg);
      return 'error';
    } finally {
      setIsSaving(false);
    }
  }, [projectPath, draft, isEditing, fileContent, setFileContent]);

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
    isEditing,
    draft,
    isDirty,
    isSaving,
    saveError,
    cancelEdit: exitEdit,
    updateDraft: setDraft,
    saveFile,
    editModeEnabled,
    setEditMode,
    pendingAction,
    confirmPendingAction,
    cancelPendingAction,
  };
}
