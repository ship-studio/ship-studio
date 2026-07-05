/**
 * Code browser tab container component.
 *
 * Combines a file tree sidebar with a syntax-highlighted code viewer.
 * Includes a draggable divider for resizing the two panes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFileTree } from '../../hooks/useFileTree';
import { useTreeDnd } from '../../hooks/useTreeDnd';
import { useOsImport } from '../../hooks/useOsImport';
import { FileTree } from './FileTree';
import { FileTreeContextMenu } from './FileTreeContextMenu';
import { CodeViewer } from './CodeViewer';
import { ConflictPromptModal, type ConflictChoice } from './ConflictPromptModal';
import { ProjectActionConfirmModal } from '../dashboard/ProjectActionConfirmModal';
import { ModalFrame } from '../primitives/ModalFrame';
import { Spinner } from '../primitives/Spinner';
import { Button } from '../primitives/Button';
import { ResetIcon, SearchIcon, TrashIcon, EditIcon } from '../icons';
import {
  moveProjectEntry,
  importPathsToProject,
  deleteProjectEntry,
  type ConflictResolution,
  type ImportOutcome,
  type FileTreeNode,
  fileExtensionForAnalytics,
} from '../../lib/code';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useOptionalToast } from '../../contexts/ToastContext';
import { trackEvent, trackSearch } from '../../lib/analytics';
import { useCommands } from '../../commands/useCommands';

/** Extensions whose moves can break source-level imports/references. */
const CODE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'vue',
  'svelte',
  'astro',
  'rs',
  'py',
  'rb',
  'go',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cpp',
  'cs',
  'php',
  'css',
  'scss',
]);

const baseName = (p: string): string => p.split('/').pop() ?? p;
const isCodeFile = (p: string): boolean => CODE_EXTENSIONS.has(fileExtensionForAnalytics(p));

interface CodeTabProps {
  projectPath: string;
  onSendToAgent?: (text: string) => void;
  /** Jump-to-code target: open this file and highlight/scroll to the line. */
  revealTarget?: { file: string; line: number } | null;
}

export function CodeTab({ projectPath, onSendToAgent, revealTarget }: CodeTabProps) {
  const {
    tree,
    expandedPaths,
    selectedFilePath,
    fileContent,
    isLoadingTree,
    isLoadingFile,
    treeError,
    fileError,
    toggleDirectory,
    expandDir,
    selectFile: selectFileRaw,
    clearSelection,
    refreshTree: refreshTreeRaw,
    isEditing,
    draft,
    isDirty,
    isSaving,
    saveError,
    cancelEdit,
    updateDraft,
    saveFile,
    editModeEnabled,
    setEditMode,
    pendingAction,
    confirmPendingAction,
    cancelPendingAction,
  } = useFileTree(projectPath);

  const selectFile = useCallback(
    (path: string) => {
      void trackEvent('code_file_opened', {
        file_extension: fileExtensionForAnalytics(path),
      });
      selectFileRaw(path);
    },
    [selectFileRaw]
  );

  const refreshTree = useCallback(() => {
    void trackEvent('code_tree_refreshed');
    refreshTreeRaw();
  }, [refreshTreeRaw]);

  // Expose the persisted edit-mode toggle in the command palette (the palette is
  // a contract — every user-facing feature registers its primary action).
  useCommands(
    () => [
      {
        id: 'code.toggleEdit',
        title: editModeEnabled ? 'Disable code editing' : 'Enable code editing',
        subtitle: 'Code tab — switch between read-only and live editing',
        icon: <EditIcon size={14} />,
        category: 'action',
        when: 'project',
        keywords: ['edit', 'code', 'editor', 'read only', 'write', 'ide'],
        run: () => setEditMode(!editModeEnabled),
      },
    ],
    [editModeEnabled, setEditMode]
  );

  // Jump-to-code: open the targeted file. The line is forwarded to CodeViewer
  // (which scrolls + highlights it) independently, so re-targeting the same file
  // still reveals the new line even though selectFile early-returns.
  useEffect(() => {
    if (revealTarget) selectFileRaw(revealTarget.file);
  }, [revealTarget, selectFileRaw]);

  const [sidebarWidth, setSidebarWidth] = useState(250);
  const [searchQuery, setSearchQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const filteredTree = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return tree;

    function filterNodes(nodes: FileTreeNode[]): FileTreeNode[] {
      const result: FileTreeNode[] = [];
      for (const node of nodes) {
        if (node.isDirectory) {
          const filteredChildren = filterNodes(node.children);
          if (filteredChildren.length > 0) {
            result.push({ ...node, children: filteredChildren });
          }
        } else if (node.name.toLowerCase().includes(query)) {
          result.push(node);
        }
      }
      return result;
    }

    return filterNodes(tree);
  }, [tree, searchQuery]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;

    let rafId: number | null = null;
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!isDragging.current || !containerRef.current) return;
        const containerRect = containerRef.current.getBoundingClientRect();
        const newWidth = e.clientX - containerRect.left;
        setSidebarWidth(Math.max(150, Math.min(newWidth, 500)));
      });
    };

    const handleMouseUp = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      isDragging.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  // ---- In-tree move (drag-and-drop) ----
  const toast = useOptionalToast();
  const [conflict, setConflict] = useState<{ from: string; toDir: string; name: string } | null>(
    null
  );

  const performMove = useCallback(
    async (from: string, toDir: string, resolution: ConflictResolution) => {
      try {
        const newRel = await moveProjectEntry(projectPath, from, toDir, resolution);
        refreshTreeRaw();
        expandDir(toDir);
        // Keep the viewer in sync when the open file — or a folder containing it
        // — is what moved; otherwise it would point at a now-dead path.
        if (selectedFilePath === from) {
          selectFileRaw(newRel);
        } else if (selectedFilePath?.startsWith(`${from}/`)) {
          selectFileRaw(`${newRel}${selectedFilePath.slice(from.length)}`);
        }
        void trackEvent('code_entry_moved');
        // Always confirm the move; append the may-break-imports caveat (don't
        // auto-fix) only for code files whose references could now be stale.
        const movedName = baseName(newRel);
        toast.showToast(
          isCodeFile(newRel)
            ? `Moved ${movedName}. If it's imported elsewhere, update those paths or ask your agent.`
            : `Moved ${movedName} to ${baseName(toDir) || 'project root'}.`,
          isCodeFile(newRel) ? 'info' : 'success'
        );
      } catch (e) {
        const err = asCommandError(e);
        if (err.type === 'Validation' && err.field === 'destination') {
          setConflict({ from, toDir, name: baseName(from) });
        } else {
          toast.showToast(formatCommandError(err), 'error');
        }
      }
    },
    [projectPath, refreshTreeRaw, expandDir, selectedFilePath, selectFileRaw, toast]
  );

  const handleTreeMove = useCallback(
    (from: string, toDir: string) => void performMove(from, toDir, 'error'),
    [performMove]
  );

  // In-tree drag is disabled while a search filter is active: the filtered view
  // hides siblings, so the drop target would be ambiguous.
  const dnd = useTreeDnd({ onMove: handleTreeMove, enabled: !searchQuery.trim() });

  // ---- OS import (drag files from Finder onto the tree) ----
  const [isImporting, setIsImporting] = useState(false);
  const importingRef = useRef(false);
  const [importConflict, setImportConflict] = useState<{
    conflicts: ImportOutcome[];
    toDir: string;
    cursor: number;
    toReplace: string[];
    toRename: string[];
  } | null>(null);
  // Mirror in a ref so the drop handler can synchronously reject a re-drop while
  // a conflict prompt is open without re-subscribing the listener.
  const importConflictRef = useRef(importConflict);
  useEffect(() => {
    importConflictRef.current = importConflict;
  }, [importConflict]);

  const performImport = useCallback(
    async (paths: string[], toDir: string, resolution: ConflictResolution) => {
      setIsImporting(true);
      importingRef.current = true;
      try {
        const outcomes = await importPathsToProject(projectPath, paths, toDir, resolution);
        refreshTreeRaw();
        if (toDir) expandDir(toDir);
        const imported = outcomes.filter((o) => o.status === 'imported');
        const conflicts = outcomes.filter((o) => o.status === 'conflict');
        if (imported.length > 0) {
          void trackEvent('code_paths_imported', { count: imported.length });
          const dest = baseName(toDir) || 'project root';
          toast.showToast(
            imported.length === 1
              ? `Imported ${baseName(imported[0].newRel ?? '')} to ${dest}.`
              : `Imported ${imported.length} items to ${dest}.`,
            'success'
          );
        }
        if (conflicts.length > 0) {
          setImportConflict({ conflicts, toDir, cursor: 0, toReplace: [], toRename: [] });
        }
      } catch (e) {
        toast.showToast(formatCommandError(asCommandError(e)), 'error');
      } finally {
        setIsImporting(false);
        importingRef.current = false;
      }
    },
    [projectPath, refreshTreeRaw, expandDir, toast]
  );

  const handleOsImport = useCallback(
    (paths: string[], toDir: string) => {
      // Ignore a fresh drop while an import is in flight or a conflict prompt is
      // open — otherwise a "looks frozen, drop again" re-drop starts a second,
      // colliding import.
      if (importingRef.current || importConflictRef.current) return;
      void performImport(paths, toDir, 'error');
    },
    [performImport]
  );
  // Stay enabled during search. Unlike an in-tree move (which needs sibling
  // context the filter hides), an OS import hit-tests the cursor against the
  // actually-rendered rows, so it always lands on a visible target. Disabling it
  // here while the sidebar still advertises `data-os-drop-zone` would black-hole
  // the drop: the terminal yields to this zone but nothing would handle it.
  const osImport = useOsImport({
    zone: 'code-files',
    onImport: handleOsImport,
  });

  // ---- Delete (right-click menu / Cmd+Delete) ----
  const [contextMenu, setContextMenu] = useState<{
    node: FileTreeNode;
    x: number;
    y: number;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    rel: string;
    name: string;
    isDir: boolean;
  } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const requestDelete = useCallback((rel: string, name: string, isDir: boolean) => {
    setContextMenu(null);
    setDeleteTarget({ rel, name, isDir });
  }, []);

  // Stable so FileTreeContextMenu's document-listener effect doesn't re-attach
  // on every CodeTab render.
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const performDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const { rel, name, isDir } = deleteTarget;
    setIsDeleting(true);
    try {
      await deleteProjectEntry(projectPath, rel);
      refreshTreeRaw();
      // If the open file — or a folder containing it — was deleted, clear the
      // viewer so it doesn't point at a now-dead path.
      if (selectedFilePath === rel || selectedFilePath?.startsWith(`${rel}/`)) {
        clearSelection();
      }
      void trackEvent('code_entry_deleted', { is_dir: isDir });
      toast.showToast(`Moved ${name} to Trash.`, 'success');
      setDeleteTarget(null);
    } catch (e) {
      toast.showToast(formatCommandError(asCommandError(e)), 'error');
    } finally {
      setIsDeleting(false);
    }
  }, [deleteTarget, projectPath, refreshTreeRaw, selectedFilePath, clearSelection, toast]);

  const handleContextMenu = useCallback(
    (node: FileTreeNode, e: React.MouseEvent) => {
      e.preventDefault();
      // Select files on right-click so the menu's target reads unambiguously;
      // folders aren't part of the selection model, so just open the menu.
      if (!node.isDirectory) selectFile(node.path);
      setContextMenu({ node, x: e.clientX, y: e.clientY });
    },
    [selectFile]
  );

  const handleSidebarKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Don't hijack editing in the search box, and don't fire while a prompt
      // is already open.
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      if (deleteTarget) return;
      // Cmd/Ctrl + Delete (or Backspace, the Mac "Delete" key) removes the
      // selected file — folders are deleted via the right-click menu.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'Backspace' || e.key === 'Delete')) {
        if (selectedFilePath) {
          e.preventDefault();
          requestDelete(selectedFilePath, baseName(selectedFilePath), false);
        }
      }
    },
    [selectedFilePath, deleteTarget, requestDelete]
  );

  // Expose "Delete file" in the Cmd+K palette while a file is open.
  useCommands(
    () =>
      selectedFilePath
        ? [
            {
              id: 'code.deleteSelected',
              title: 'Delete file…',
              icon: <TrashIcon size={14} />,
              category: 'action' as const,
              when: 'project' as const,
              keywords: ['remove', 'trash', 'delete'],
              run: () => requestDelete(selectedFilePath, baseName(selectedFilePath), false),
            },
          ]
        : [],
    [selectedFilePath, requestDelete]
  );

  // Resolve OS-import name collisions one at a time (with "apply to the rest"),
  // then re-import the chosen sources grouped by policy. Skipped ones are dropped.
  const resolveImportConflict = useCallback(
    (choice: ConflictChoice, applyToAll: boolean) => {
      if (!importConflict) return;
      const { conflicts, toDir, cursor, toReplace, toRename } = importConflict;
      const end = applyToAll ? conflicts.length : cursor + 1;
      const batch = conflicts.slice(cursor, end).map((c) => c.source);
      const nextReplace = choice === 'replace' ? [...toReplace, ...batch] : toReplace;
      const nextRename = choice === 'rename' ? [...toRename, ...batch] : toRename;
      if (end >= conflicts.length) {
        setImportConflict(null);
        // Run the two policy buckets sequentially: start rename only after the
        // replace import settles, so they can't write into the same destination
        // tree concurrently and race on final names/content.
        if (nextReplace.length) {
          void performImport(nextReplace, toDir, 'replace').then(() => {
            if (nextRename.length) void performImport(nextRename, toDir, 'rename');
          });
        } else if (nextRename.length) {
          void performImport(nextRename, toDir, 'rename');
        }
      } else {
        setImportConflict({
          ...importConflict,
          cursor: end,
          toReplace: nextReplace,
          toRename: nextRename,
        });
      }
    },
    [importConflict, performImport]
  );

  // Dismissing the prompt (ESC / overlay / close) cancels the remaining conflict
  // handling entirely — no pending replace/rename is committed (Replace is
  // destructive, so dismissal must mean "change nothing further").
  const dismissImportConflict = useCallback(() => {
    setImportConflict(null);
  }, []);

  return (
    <div className="code-tab" ref={containerRef}>
      <div
        className="code-tab-sidebar"
        style={{ width: sidebarWidth }}
        onKeyDown={handleSidebarKeyDown}
      >
        <div className="code-tab-sidebar-header">
          <span className="code-tab-sidebar-title">Files</span>
          <button className="code-tab-refresh-btn" onClick={refreshTree} title="Refresh file tree">
            <ResetIcon size={12} />
          </button>
        </div>
        <div className="code-tab-search">
          <SearchIcon size={12} />
          <input
            className="code-tab-search-input"
            type="text"
            placeholder="Search files..."
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              trackSearch('code_files', e.target.value);
            }}
          />
        </div>
        <div
          className={`code-tab-sidebar-content${
            dnd.dropTargetDir === '' || osImport.dropTargetDir === '' ? ' root-drop-target' : ''
          }`}
          data-os-drop-zone={!searchQuery.trim() ? 'code-files' : undefined}
          onDragOver={dnd.onRootDragOver}
          onDrop={dnd.onRootDrop}
        >
          {isImporting && (
            <div className="code-tab-importing">
              <Spinner size="sm" />
              <span>Importing…</span>
            </div>
          )}
          {isLoadingTree ? (
            <div className="code-tab-sidebar-loading">
              <Spinner size="sm" style={{ color: 'var(--accent)' }} />
            </div>
          ) : treeError ? (
            <div className="code-tab-sidebar-error">
              <span>Failed to load files</span>
              <Button variant="secondary" size="sm" onClick={refreshTree}>
                Retry
              </Button>
            </div>
          ) : filteredTree.length === 0 ? (
            <div className="code-tab-sidebar-empty">
              {searchQuery.trim() ? 'No matching files' : 'No files found'}
            </div>
          ) : (
            <FileTree
              nodes={filteredTree}
              expandedPaths={expandedPaths}
              selectedFilePath={selectedFilePath}
              onToggleDirectory={toggleDirectory}
              onSelectFile={selectFile}
              dnd={searchQuery.trim() ? undefined : dnd}
              osDropTargetDir={osImport.dropTargetDir}
              onContextMenu={handleContextMenu}
              contextTargetPath={contextMenu?.node.path ?? null}
            />
          )}
        </div>
      </div>
      <div className="code-tab-divider" onMouseDown={handleMouseDown} />
      <div className="code-tab-viewer">
        <CodeViewer
          projectPath={projectPath}
          filePath={selectedFilePath}
          fileContent={fileContent}
          isLoading={isLoadingFile}
          error={fileError}
          onSendToAgent={onSendToAgent}
          revealLine={
            revealTarget && revealTarget.file === selectedFilePath ? revealTarget.line : null
          }
          isEditing={isEditing}
          draft={draft}
          isDirty={isDirty}
          isSaving={isSaving}
          saveError={saveError}
          onCancelEdit={cancelEdit}
          onDraftChange={updateDraft}
          onSave={saveFile}
          editModeEnabled={editModeEnabled}
          onToggleEditMode={setEditMode}
        />
      </div>
      <ConflictPromptModal
        isOpen={!!conflict}
        name={conflict?.name ?? ''}
        // Root drops pass undefined → the modal reads "this folder" (no fake label).
        targetLabel={conflict && conflict.toDir ? baseName(conflict.toDir) : undefined}
        // Single in-tree move: applyToAll is intentionally unused (remaining=0).
        onResolve={(choice) => {
          const c = conflict;
          setConflict(null);
          if (c && choice !== 'skip') void performMove(c.from, c.toDir, choice);
        }}
        onClose={() => setConflict(null)}
      />
      <ConflictPromptModal
        isOpen={!!importConflict}
        name={
          importConflict ? baseName(importConflict.conflicts[importConflict.cursor].source) : ''
        }
        targetLabel={
          importConflict && importConflict.toDir ? baseName(importConflict.toDir) : undefined
        }
        remaining={importConflict ? importConflict.conflicts.length - importConflict.cursor - 1 : 0}
        onResolve={resolveImportConflict}
        onClose={dismissImportConflict}
      />
      {contextMenu && (
        <FileTreeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          name={contextMenu.node.name}
          onDelete={() =>
            requestDelete(
              contextMenu.node.path,
              contextMenu.node.name,
              contextMenu.node.isDirectory
            )
          }
          onClose={closeContextMenu}
        />
      )}
      {deleteTarget && (
        <ModalFrame
          isOpen
          onClose={() => {
            if (!isDeleting) setDeleteTarget(null);
          }}
          title="Move to Trash"
          showCloseButton={false}
        >
          <div style={{ padding: 'var(--spacing-xl)' }}>
            <p>
              Move <strong>{deleteTarget.name}</strong>
              {deleteTarget.isDir ? ' and everything inside it' : ''} to the Trash?
            </p>
            <p className="hint">You can restore it from your Trash.</p>
            <div className="modal-actions">
              <Button
                variant="secondary"
                onClick={() => setDeleteTarget(null)}
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button variant="danger" onClick={() => void performDelete()} disabled={isDeleting}>
                {isDeleting ? 'Moving…' : 'Move to Trash'}
              </Button>
            </div>
          </div>
        </ModalFrame>
      )}
      {pendingAction && (
        <ProjectActionConfirmModal
          title="Discard unsaved changes?"
          body={
            <span style={{ display: 'block', marginBottom: 'var(--spacing-md)' }}>
              {pendingAction.kind === 'switch'
                ? 'You have unsaved changes in this file. Switching files will discard them.'
                : 'You have unsaved changes. Turning off Edit mode will discard them.'}
            </span>
          }
          hint="This can’t be undone."
          loading={false}
          confirmLabel="Discard changes"
          loadingLabel="Discarding…"
          confirmVariant="danger"
          onCancel={cancelPendingAction}
          onConfirm={confirmPendingAction}
        />
      )}
    </div>
  );
}
