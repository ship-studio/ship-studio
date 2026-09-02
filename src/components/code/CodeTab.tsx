import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFileTree } from '../../hooks/useFileTree';
import { FileTree } from './FileTree';
import { CodeViewer } from './CodeViewer';
import { ProjectActionConfirmModal } from '../dashboard/ProjectActionConfirmModal';
import { Spinner } from '../primitives/Spinner';
import { Button } from '../primitives/Button';
import { ResetIcon, SearchIcon, EditIcon, FileIcon, CodeIcon } from '../icons';
import {
  type FileTreeNode,
  type CodeSearchResult,
  searchProjectCode,
  fileExtensionForAnalytics,
} from '../../lib/code';
import { trackEvent, trackSearch } from '../../lib/analytics';
import { useCommands } from '../../commands/useCommands';

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
    selectFile: selectFileRaw,
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

  const [activeRevealTarget, setActiveRevealTarget] = useState<{
    file: string;
    line: number;
  } | null>(revealTarget ?? null);

  const selectFile = useCallback(
    (path: string, line?: number) => {
      void trackEvent('code_file_opened', {
        file_extension: fileExtensionForAnalytics(path),
      });
      selectFileRaw(path);
      if (line != null) {
        setActiveRevealTarget({ file: path, line });
      }
    },
    [selectFileRaw]
  );

  const refreshTree = useCallback(() => {
    void trackEvent('code_tree_refreshed');
    refreshTreeRaw();
  }, [refreshTreeRaw]);

  const [searchMode, setSearchMode] = useState<'files' | 'code'>('files');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<CodeSearchResult[]>([]);
  const [isSearchingCode, setIsSearchingCode] = useState(false);
  const [openSearchTrigger, setOpenSearchTrigger] = useState<number>(0);

  // Expose search & edit commands in the Cmd+K palette.
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
      {
        id: 'code.findInFile',
        title: 'Find in current file',
        subtitle: 'Code tab — open in-file search panel in editor',
        icon: <SearchIcon size={14} />,
        category: 'action',
        when: 'project',
        keywords: ['find', 'search', 'file', 'code', 'buffer'],
        run: () => setOpenSearchTrigger((prev) => prev + 1),
      },
      {
        id: 'code.toggleSearchMode',
        title:
          searchMode === 'files' ? 'Switch to code content search' : 'Switch to file path search',
        subtitle: 'Code tab — toggle search mode in sidebar',
        icon: <CodeIcon size={14} />,
        category: 'action',
        when: 'project',
        keywords: ['search', 'grep', 'mode', 'content', 'path', 'files'],
        run: () => setSearchMode((prev) => (prev === 'files' ? 'code' : 'files')),
      },
    ],
    [editModeEnabled, setEditMode, searchMode]
  );

  // Jump-to-code: open targeted file & store reveal line.
  useEffect(() => {
    if (revealTarget) {
      selectFileRaw(revealTarget.file);
      const timer = setTimeout(() => {
        setActiveRevealTarget(revealTarget);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [revealTarget, selectFileRaw]);

  // Debounced cross-file code search execution.
  useEffect(() => {
    if (searchMode !== 'code' || !searchQuery.trim()) {
      const timer = setTimeout(() => {
        setSearchResults([]);
        setIsSearchingCode(false);
      }, 0);
      return () => clearTimeout(timer);
    }

    const timer = setTimeout(() => {
      setIsSearchingCode(true);
      searchProjectCode(projectPath, searchQuery.trim())
        .then((results) => {
          setSearchResults(results);
        })
        .catch(() => {
          setSearchResults([]);
        })
        .finally(() => {
          setIsSearchingCode(false);
        });
    }, 250);

    return () => clearTimeout(timer);
  }, [searchMode, searchQuery, projectPath]);

  const [sidebarWidth, setSidebarWidth] = useState(250);
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

  return (
    <div className="code-tab" ref={containerRef}>
      <div className="code-tab-sidebar" style={{ width: sidebarWidth }}>
        <div className="code-tab-sidebar-header">
          <span className="code-tab-sidebar-title">
            {searchMode === 'files' ? 'Files' : 'Code Search'}
          </span>
          <button className="code-tab-refresh-btn" onClick={refreshTree} title="Refresh file tree">
            <ResetIcon size={12} />
          </button>
        </div>
        <div className="code-tab-search">
          <SearchIcon size={12} />
          <input
            className="code-tab-search-input"
            type="text"
            placeholder={searchMode === 'files' ? 'Search file paths...' : 'Search code content...'}
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
          <button
            type="button"
            className={`code-search-mode-toggle${searchMode === 'code' ? ' active' : ''}`}
            onClick={() => setSearchMode((prev) => (prev === 'files' ? 'code' : 'files'))}
            title={
              searchMode === 'files'
                ? 'Switch to Code Content Search (cross-file grep)'
                : 'Switch to File Path Search'
            }
          >
            {searchMode === 'files' ? <FileIcon size={12} /> : <CodeIcon size={12} />}
            <span className="code-search-mode-label">
              {searchMode === 'files' ? 'Files' : 'Code'}
            </span>
          </button>
        </div>
        <div className="code-tab-sidebar-content">
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
          ) : searchMode === 'code' ? (
            isSearchingCode ? (
              <div className="code-tab-sidebar-loading">
                <Spinner size="sm" style={{ color: 'var(--accent)' }} />
                <span>Searching code...</span>
              </div>
            ) : !searchQuery.trim() ? (
              <div className="code-tab-sidebar-empty">Type query to search across files</div>
            ) : searchResults.length === 0 ? (
              <div className="code-tab-sidebar-empty">No matching code content</div>
            ) : (
              <div className="code-search-results">
                {searchResults.map((res) => (
                  <div key={res.filePath} className="code-search-file-group">
                    <div
                      className="code-search-file-header"
                      onClick={() => selectFile(res.filePath)}
                      title={res.filePath}
                    >
                      <FileIcon size={12} />
                      <span className="code-search-file-path">{res.filePath}</span>
                      <span className="code-search-file-count">{res.matches.length}</span>
                    </div>
                    <div className="code-search-file-matches">
                      {res.matches.map((m) => (
                        <button
                          key={`${res.filePath}:${m.lineNumber}`}
                          type="button"
                          className="code-search-match-item"
                          onClick={() => selectFile(res.filePath, m.lineNumber)}
                        >
                          <span className="code-search-match-line">{m.lineNumber}</span>
                          <span className="code-search-match-text" title={m.lineText}>
                            {m.lineText}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )
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
            activeRevealTarget && activeRevealTarget.file === selectedFilePath
              ? activeRevealTarget.line
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
          openSearchTrigger={openSearchTrigger}
          onTriggerSearch={() => setOpenSearchTrigger((prev) => prev + 1)}
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
