/**
 * Code browser tab container component.
 *
 * Combines a file tree sidebar with a syntax-highlighted code viewer.
 * Includes a draggable divider for resizing the two panes.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { useFileTree } from '../hooks/useFileTree';
import { FileTree } from './FileTree';
import { CodeViewer } from './CodeViewer';
import { ResetIcon, SearchIcon } from './icons';
import { type FileTreeNode, fileExtensionForAnalytics } from '../lib/code';
import { trackEvent, trackSearch } from '../lib/analytics';

interface CodeTabProps {
  projectPath: string;
  onSendToAgent?: (text: string) => void;
}

export function CodeTab({ projectPath, onSendToAgent }: CodeTabProps) {
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

  return (
    <div className="code-tab" ref={containerRef}>
      <div className="code-tab-sidebar" style={{ width: sidebarWidth }}>
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
        <div className="code-tab-sidebar-content">
          {isLoadingTree ? (
            <div className="code-tab-sidebar-loading">
              <div className="capture-spinner" />
            </div>
          ) : treeError ? (
            <div className="code-tab-sidebar-error">
              <span>Failed to load files</span>
              <button className="code-tab-retry-btn" onClick={refreshTree}>
                Retry
              </button>
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
      <div className="code-tab-divider" onMouseDown={handleMouseDown} />
      <div className="code-tab-viewer">
        <CodeViewer
          projectPath={projectPath}
          filePath={selectedFilePath}
          fileContent={fileContent}
          isLoading={isLoadingFile}
          error={fileError}
          onSendToAgent={onSendToAgent}
        />
      </div>
    </div>
  );
}
