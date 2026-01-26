/**
 * AssetsPanel component for managing files in the /public folder.
 *
 * Provides a modal interface to:
 * - View assets in the /public folder (recursive listing)
 * - Upload new files via drag-and-drop or file picker
 * - Rename and delete assets
 * - Create new folders
 * - Copy asset paths for use in code
 *
 * @module components/AssetsPanel
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  listAssets,
  uploadAsset,
  deleteAsset,
  renameAsset,
  createAssetFolder,
  formatFileSize,
  isImageFile,
  Asset,
} from '../lib/assets';
import {
  CloseIcon,
  CopyIcon,
  TrashIcon,
  EditIcon,
  UploadIcon,
  FolderIcon,
  FileIcon,
  ImageIcon,
  ChevronRightIcon,
  FolderPlusIcon,
  CheckIcon,
  SearchIcon,
} from './icons';

// Grid and List icons for view toggle
function GridIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </svg>
  );
}

function ListIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}

interface AssetsPanelProps {
  /** Absolute path to the project directory */
  projectPath: string;
  /** Whether the panel is open */
  isOpen: boolean;
  /** Callback to close the panel */
  onClose: () => void;
  /** Optional callback to show toast notifications */
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

export function AssetsPanel({ projectPath, isOpen, onClose, onToast }: AssetsPanelProps) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<Asset | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const deleteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  // Load assets
  const loadAssets = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const allAssets = await listAssets(projectPath);
      setAssets(allAssets);
    } catch (e) {
      setError('Failed to load assets');
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    if (isOpen) {
      void loadAssets();
      setCurrentPath('');
      setSearchQuery('');
    }
  }, [isOpen, loadAssets]);

  // Get assets for current path (filtered view)
  const currentAssets = assets.filter((asset) => {
    // If searching, search across all assets
    if (searchQuery.trim()) {
      return asset.name.toLowerCase().includes(searchQuery.toLowerCase());
    }

    if (currentPath === '') {
      // Root level - show only items without "/" in their path
      return !asset.path.includes('/');
    } else {
      // Inside a folder - show items that start with currentPath/ but don't have additional slashes
      const prefix = currentPath + '/';
      if (!asset.path.startsWith(prefix)) return false;
      const remaining = asset.path.slice(prefix.length);
      return !remaining.includes('/');
    }
  });

  // Sort: folders first, then files alphabetically
  const sortedAssets = [...currentAssets].sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });

  // Breadcrumb navigation
  const pathParts = currentPath ? currentPath.split('/') : [];
  const breadcrumbs = [
    { name: 'public', path: '' },
    ...pathParts.map((part, index) => ({
      name: part,
      path: pathParts.slice(0, index + 1).join('/'),
    })),
  ];

  // Handle file upload
  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    setIsUploading(true);
    setError(null);

    try {
      for (const file of Array.from(files)) {
        const arrayBuffer = await file.arrayBuffer();
        const fileData = Array.from(new Uint8Array(arrayBuffer));
        await uploadAsset(projectPath, currentPath || '/', file.name, fileData);
      }
      await loadAssets();
      onToast?.(
        files.length === 1 ? `Uploaded ${files[0].name}` : `Uploaded ${files.length} files`,
        'success'
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to upload';
      setError(msg);
      onToast?.(msg, 'error');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // Handle delete - first click arms it, second click confirms
  const handleDeleteClick = async (asset: Asset) => {
    // Clear any existing timeout
    if (deleteTimeoutRef.current) {
      clearTimeout(deleteTimeoutRef.current);
      deleteTimeoutRef.current = null;
    }

    if (deleteTarget === asset.path) {
      // Second click - actually delete
      try {
        await deleteAsset(projectPath, asset.path);
        await loadAssets();
        onToast?.(`Deleted ${asset.name}`, 'success');
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to delete';
        setError(msg);
        onToast?.(msg, 'error');
      } finally {
        setDeleteTarget(null);
      }
    } else {
      // First click - arm for deletion
      setDeleteTarget(asset.path);
      // Reset after 10 seconds
      deleteTimeoutRef.current = setTimeout(() => {
        setDeleteTarget(null);
      }, 10000);
    }
  };

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (deleteTimeoutRef.current) {
        clearTimeout(deleteTimeoutRef.current);
      }
    };
  }, []);

  // Handle rename
  const startRename = (asset: Asset) => {
    setRenameTarget(asset);
    setRenameValue(asset.name);
  };

  const handleRename = async () => {
    if (!renameTarget || !renameValue.trim()) return;
    if (renameValue === renameTarget.name) {
      setRenameTarget(null);
      return;
    }

    try {
      await renameAsset(projectPath, renameTarget.path, renameValue.trim());
      await loadAssets();
      onToast?.(`Renamed to ${renameValue.trim()}`, 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to rename';
      setError(msg);
      onToast?.(msg, 'error');
    } finally {
      setRenameTarget(null);
    }
  };

  // Handle create folder
  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;

    const folderPath = currentPath
      ? `${currentPath}/${newFolderName.trim()}`
      : newFolderName.trim();

    try {
      await createAssetFolder(projectPath, folderPath);
      await loadAssets();
      onToast?.(`Created folder ${newFolderName.trim()}`, 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to create folder';
      setError(msg);
      onToast?.(msg, 'error');
    } finally {
      setShowNewFolder(false);
      setNewFolderName('');
    }
  };

  // Handle copy path
  const handleCopyPath = async (asset: Asset) => {
    const webPath = `/${asset.path}`;
    try {
      await navigator.clipboard.writeText(webPath);
      setCopiedPath(asset.path);
      setTimeout(() => setCopiedPath(null), 2000);
      onToast?.(`Copied ${webPath}`, 'success');
    } catch (e) {
      console.error('Failed to copy:', e);
    }
  };

  // Navigate into folder
  const navigateToFolder = (asset: Asset) => {
    if (asset.isDirectory) {
      setCurrentPath(asset.path);
    }
  };

  // Drag and drop handlers
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only set dragging to false if we're leaving the drop zone entirely
    const rect = dropZoneRef.current?.getBoundingClientRect();
    if (rect) {
      const { clientX, clientY } = e;
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        setIsDragging(false);
      }
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    void handleUpload(e.dataTransfer.files);
  };

  // Render asset preview (thumbnail for images, icon for others)
  const renderAssetPreview = (asset: Asset) => {
    if (asset.isDirectory) {
      return (
        <div className="assets-item-file-icon">
          <FolderIcon size={18} />
        </div>
      );
    }
    if (isImageFile(asset.name)) {
      return (
        <img
          className="assets-item-thumbnail"
          src={convertFileSrc(asset.fullPath)}
          alt={asset.name}
          loading="lazy"
        />
      );
    }
    return (
      <div className="assets-item-file-icon">
        <FileIcon size={16} />
      </div>
    );
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal assets-panel-modal" onClick={(e) => e.stopPropagation()}>
        <div className="assets-panel-header">
          <h3>Assets</h3>
          <button className="assets-close-btn" onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="assets-panel-content">
          {/* Toolbar */}
          <div className="assets-toolbar">
            <button
              className="assets-toolbar-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
            >
              <UploadIcon size={14} />
              {isUploading ? 'Uploading...' : 'Upload'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={(e) => void handleUpload(e.target.files)}
              style={{ display: 'none' }}
            />
            <button className="assets-toolbar-btn" onClick={() => setShowNewFolder(true)}>
              <FolderPlusIcon size={14} />
              New Folder
            </button>
            <div className="assets-toolbar-spacer" />
            <div className="assets-view-toggle">
              <button
                className={`assets-view-btn ${viewMode === 'list' ? 'active' : ''}`}
                onClick={() => setViewMode('list')}
                title="List view"
              >
                <ListIcon size={14} />
              </button>
              <button
                className={`assets-view-btn ${viewMode === 'grid' ? 'active' : ''}`}
                onClick={() => setViewMode('grid')}
                title="Grid view"
              >
                <GridIcon size={14} />
              </button>
            </div>
          </div>

          {/* Search */}
          <div className="assets-search">
            <SearchIcon size={14} />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search assets..."
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            {searchQuery && (
              <button className="assets-search-clear" onClick={() => setSearchQuery('')}>
                <CloseIcon size={12} />
              </button>
            )}
          </div>

          {/* Breadcrumb navigation */}
          {!searchQuery && (
            <div className="assets-breadcrumb">
              {breadcrumbs.map((crumb, index) => (
                <span key={crumb.path} className="assets-breadcrumb-item">
                  {index > 0 && <ChevronRightIcon size={12} />}
                  <button
                    className={`assets-breadcrumb-btn ${
                      index === breadcrumbs.length - 1 ? 'active' : ''
                    }`}
                    onClick={() => setCurrentPath(crumb.path)}
                  >
                    {crumb.name}
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* New folder input */}
          {showNewFolder && (
            <div className="assets-new-folder">
              <FolderIcon size={16} />
              <input
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreateFolder();
                  if (e.key === 'Escape') {
                    setShowNewFolder(false);
                    setNewFolderName('');
                  }
                }}
                placeholder="Folder name"
                autoFocus
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <button
                className="assets-new-folder-confirm"
                onClick={() => void handleCreateFolder()}
              >
                <CheckIcon size={14} />
              </button>
              <button
                className="assets-new-folder-cancel"
                onClick={() => {
                  setShowNewFolder(false);
                  setNewFolderName('');
                }}
              >
                <CloseIcon size={14} />
              </button>
            </div>
          )}

          {/* Assets list / drop zone */}
          <div
            ref={dropZoneRef}
            className={`assets-list-container ${isDragging ? 'dragging' : ''}`}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            {isLoading ? (
              <div className="assets-loading">Loading assets...</div>
            ) : sortedAssets.length === 0 ? (
              <div className="assets-empty">
                <div className="assets-empty-icon">
                  {searchQuery ? <SearchIcon size={32} /> : <ImageIcon size={32} />}
                </div>
                <p>
                  {searchQuery ? `No assets matching "${searchQuery}"` : 'No assets in this folder'}
                </p>
                {!searchQuery && (
                  <p className="assets-empty-hint">Drag and drop files here or click Upload</p>
                )}
              </div>
            ) : viewMode === 'list' ? (
              <div className="assets-list">
                {sortedAssets.map((asset) => (
                  <div
                    key={asset.path}
                    className={`assets-item ${asset.isDirectory ? 'is-folder' : ''}`}
                  >
                    <div
                      className="assets-item-main"
                      onClick={() => (asset.isDirectory ? navigateToFolder(asset) : null)}
                    >
                      {renderAssetPreview(asset)}
                      {renameTarget?.path === asset.path ? (
                        <input
                          type="text"
                          className="assets-rename-input"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleRename();
                            if (e.key === 'Escape') setRenameTarget(null);
                          }}
                          onBlur={() => void handleRename()}
                          autoFocus
                          autoComplete="off"
                          autoCorrect="off"
                          autoCapitalize="off"
                          spellCheck={false}
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <span className="assets-item-name">{asset.name}</span>
                      )}
                      {!asset.isDirectory && (
                        <span className="assets-item-size">{formatFileSize(asset.size)}</span>
                      )}
                    </div>
                    <div className="assets-item-actions">
                      <button
                        className="assets-action-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleCopyPath(asset);
                        }}
                        title="Copy path"
                      >
                        {copiedPath === asset.path ? (
                          <CheckIcon size={12} />
                        ) : (
                          <CopyIcon size={12} />
                        )}
                      </button>
                      <button
                        className="assets-action-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          startRename(asset);
                        }}
                        title="Rename"
                      >
                        <EditIcon size={12} />
                      </button>
                      <button
                        className={`assets-action-btn assets-action-delete ${deleteTarget === asset.path ? 'armed' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDeleteClick(asset);
                        }}
                        title={deleteTarget === asset.path ? 'Click to confirm delete' : 'Delete'}
                      >
                        {deleteTarget === asset.path ? (
                          <CheckIcon size={12} />
                        ) : (
                          <TrashIcon size={12} />
                        )}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="assets-grid">
                {sortedAssets.map((asset) => (
                  <div
                    key={asset.path}
                    className={`assets-grid-item ${asset.isDirectory ? 'is-folder' : ''}`}
                    onClick={() => (asset.isDirectory ? navigateToFolder(asset) : null)}
                  >
                    <div className="assets-grid-preview">
                      {asset.isDirectory ? (
                        <FolderIcon size={32} />
                      ) : isImageFile(asset.name) ? (
                        <img src={convertFileSrc(asset.fullPath)} alt={asset.name} loading="lazy" />
                      ) : (
                        <FileIcon size={32} />
                      )}
                    </div>
                    <div className="assets-grid-info">
                      {renameTarget?.path === asset.path ? (
                        <input
                          type="text"
                          className="assets-rename-input"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleRename();
                            if (e.key === 'Escape') setRenameTarget(null);
                          }}
                          onBlur={() => void handleRename()}
                          autoFocus
                          autoComplete="off"
                          autoCorrect="off"
                          autoCapitalize="off"
                          spellCheck={false}
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <span className="assets-grid-name" title={asset.name}>
                          {asset.name}
                        </span>
                      )}
                    </div>
                    <div className="assets-grid-actions">
                      <button
                        className="assets-action-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleCopyPath(asset);
                        }}
                        title="Copy path"
                      >
                        {copiedPath === asset.path ? (
                          <CheckIcon size={12} />
                        ) : (
                          <CopyIcon size={12} />
                        )}
                      </button>
                      <button
                        className="assets-action-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          startRename(asset);
                        }}
                        title="Rename"
                      >
                        <EditIcon size={12} />
                      </button>
                      <button
                        className={`assets-action-btn assets-action-delete ${deleteTarget === asset.path ? 'armed' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDeleteClick(asset);
                        }}
                        title={deleteTarget === asset.path ? 'Click to confirm delete' : 'Delete'}
                      >
                        {deleteTarget === asset.path ? (
                          <CheckIcon size={12} />
                        ) : (
                          <TrashIcon size={12} />
                        )}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Drag overlay */}
            {isDragging && (
              <div className="assets-drag-overlay">
                <UploadIcon size={32} />
                <p>Drop files to upload</p>
              </div>
            )}
          </div>

          {error && <div className="assets-error">{error}</div>}
        </div>
      </div>
    </div>
  );
}
