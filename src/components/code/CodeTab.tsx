/**
 * Code browser tab container component.
 *
 * Combines a file tree sidebar with a syntax-highlighted code viewer.
 * Includes a draggable divider for resizing the two panes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFileTree } from '../../hooks/useFileTree';
import { FileTree } from './FileTree';
import { CodeViewer } from './CodeViewer';
import { ProjectActionConfirmModal } from '../dashboard/ProjectActionConfirmModal';
import { Spinner } from '../primitives/Spinner';
import { Button } from '../primitives/Button';
import { PanelResizeHandle } from '../primitives/PanelResizeHandle';
import { IconButton } from '../primitives/IconButton';
import { ResetIcon, EditIcon } from '@/components/icons';
import { SearchField } from '../primitives/SearchField';
import { type CodeRevealTarget, type FileTreeNode } from '../../lib/code';
import { useCommands } from '../../commands/useCommands';

interface CodeTabProps {
  projectPath: string;
  onSendToAgent?: (text: string) => void;
  /** Jump-to-code target: open this file and highlight/scroll to the line. */
  revealTarget?: CodeRevealTarget | null;
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
    selectFile: selectFileRaw,
    revealFile,
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

  const selectFile = selectFileRaw;
  const refreshTree = refreshTreeRaw;
  const [sidebarWidth, setSidebarWidth] = useState(250);
  const [searchQuery, setSearchQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const handledRevealRef = useRef<CodeTabProps['revealTarget']>(null);
  const pendingRevealPathRef = useRef<string | null>(null);

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

  // External source links target physical source paths. Wait until this project's
  // tree has loaded so revealFile can expand known ancestors or select a readable
  // source file omitted from the tree, then clear any filter hiding the target.
  useEffect(() => {
    if (!revealTarget || isLoadingTree || treeError || handledRevealRef.current === revealTarget)
      return;
    if (!revealFile(revealTarget.file)) return;
    handledRevealRef.current = revealTarget;
    pendingRevealPathRef.current = revealTarget.file;
    const resetSearch = window.setTimeout(() => setSearchQuery(''), 0);
    return () => window.clearTimeout(resetSearch);
  }, [isLoadingTree, revealFile, revealTarget, treeError]);

  // Keep the selected entry visible after expanding a source path's ancestors.
  useEffect(() => {
    if (!selectedFilePath || selectedFilePath !== pendingRevealPathRef.current) return;
    const selectedRow = containerRef.current?.querySelector<HTMLElement>(
      '.code-tab-sidebar-content [aria-selected="true"]'
    );
    if (selectedRow) {
      selectedRow.scrollIntoView?.({ block: 'nearest' });
      pendingRevealPathRef.current = null;
    }
  }, [expandedPaths, searchQuery, selectedFilePath]);

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

  const handleSearchChange = useCallback((value: string) => setSearchQuery(value), []);

  const resizeSidebar = useCallback((clientX: number) => {
    if (!containerRef.current) return;
    const containerRect = containerRef.current.getBoundingClientRect();
    const newWidth = clientX - containerRect.left;
    setSidebarWidth(Math.max(150, Math.min(newWidth, 500)));
  }, []);

  const resizeSidebarBy = useCallback((delta: number) => {
    setSidebarWidth((width) => Math.max(150, Math.min(width + delta, 500)));
  }, []);

  return (
    <div className="code-tab" ref={containerRef}>
      <div className="code-tab-sidebar" style={{ width: sidebarWidth }}>
        <div className="code-tab-sidebar-header">
          <span className="code-tab-sidebar-title">Files</span>
          <IconButton
            variant="ghost"
            size="compact"
            onClick={refreshTree}
            title="Refresh file tree"
            aria-label="Refresh file tree"
            icon={<ResetIcon size={12} />}
          />
        </div>
        <SearchField
          className="code-tab-search"
          value={searchQuery}
          onChange={handleSearchChange}
          aria-label="Search project files"
          placeholder="Search files..."
          autoCorrect="off"
          autoCapitalize="off"
        />
        <div className="code-tab-sidebar-content">
          {isLoadingTree ? (
            <div className="code-tab-sidebar-loading">
              <Spinner size="sm" style={{ color: 'var(--accent-active)' }} />
            </div>
          ) : treeError ? (
            <div className="code-tab-sidebar-error">
              <span>Failed to load files</span>
              <Button variant="secondary" size="compact" onClick={refreshTree}>
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
            />
          )}
        </div>
      </div>
      <PanelResizeHandle
        value={sidebarWidth}
        min={150}
        max={500}
        label="Resize Files panel"
        onResize={resizeSidebar}
        onResizeBy={resizeSidebarBy}
      />
      <div className="code-tab-viewer">
        <CodeViewer
          projectPath={projectPath}
          filePath={selectedFilePath}
          fileContent={fileContent}
          isLoading={isLoadingFile}
          error={fileError}
          onSendToAgent={onSendToAgent}
          revealLine={
            revealTarget && revealTarget.file === selectedFilePath && !isLoadingFile
              ? revealTarget.line
              : null
          }
          revealRequestId={
            revealTarget && revealTarget.file === selectedFilePath && !isLoadingFile
              ? revealTarget.requestId
              : null
          }
          revealRange={
            revealTarget && revealTarget.file === selectedFilePath && !isLoadingFile
              ? revealTarget.range
              : null
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
