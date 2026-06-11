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
 * The modal body is exported separately as `AssetsModal` with explicit
 * open/close props plus an optional pick mode, so other features (the visual
 * editor's "Replace image") reuse the exact same browser as a file picker
 * instead of growing a second asset UI.
 *
 * @module components/AssetsPanel
 */

import { useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { formatFileSize, isImageFile, type Asset } from '../lib/assets';
import { useAssetManagement } from '../hooks/useAssetManagement';
import { useClickOutside } from '../hooks/useClickOutside';
import { useOptionalToast } from '../contexts/ToastContext';
import { useModal } from '../contexts/ModalContext';
import {
  CloseIcon,
  CopyIcon,
  TrashIcon,
  EditIcon,
  UploadIcon,
  FolderIcon,
  FileIcon,
  ImageIcon,
  ChevronIcon,
  ChevronRightIcon,
  FolderPlusIcon,
  CheckIcon,
  SearchIcon,
} from './icons';

/** Common asset folders offered in the root picker. */
const ASSETS_ROOT_SUGGESTIONS = ['public', 'src/assets', 'assets', 'static'];

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
}

/** The workspace Assets manager — the `AssetsModal` body bound to the
 *  'assetsPanel' modal id. */
export function AssetsPanel({ projectPath }: AssetsPanelProps) {
  const { isOpen, close } = useModal('assetsPanel');
  return <AssetsModal projectPath={projectPath} isOpen={isOpen} onClose={close} />;
}

export interface AssetsModalProps {
  /** Absolute path to the project directory */
  projectPath: string;
  isOpen: boolean;
  onClose: () => void;
  /** Pick mode: the same browser, but image files become click-to-pick targets
   *  (non-image files are hidden, folders still navigate) and the title says
   *  what the pick is for. Management actions (upload, rename, …) stay — a
   *  picker is the moment you notice the asset needs a tweak. */
  pick?: {
    /** Modal title, e.g. "Replace image". */
    title: string;
    onPick: (asset: Asset) => void;
  };
}

export function AssetsModal({ projectPath, isOpen, onClose, pick }: AssetsModalProps) {
  const { showToast } = useOptionalToast();
  const onToast = (message: string, type?: 'success' | 'error') => showToast(message, type);
  const {
    setCurrentPath,
    isLoading,
    error,
    renameTarget,
    setRenameTarget,
    renameValue,
    setRenameValue,
    showNewFolder,
    setShowNewFolder,
    newFolderName,
    setNewFolderName,
    isDragging,
    isUploading,
    copiedPath,
    viewMode,
    setViewMode,
    searchQuery,
    setSearchQuery,
    clearSearchQuery,
    deleteTarget,
    assetsRoot,
    changeAssetsRoot,
    fileInputRef,
    dropZoneRef,
    sortedAssets,
    breadcrumbs,
    handleUpload,
    handleDeleteClick,
    startRename,
    handleRename,
    handleCreateFolder,
    handleCopyPath,
    navigateToFolder,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
  } = useAssetManagement({ projectPath, isOpen, onToast });

  // --- Assets root picker state ---
  const [rootMenuOpen, setRootMenuOpen] = useState(false);
  // null = not editing; string = custom folder input value
  const [customRoot, setCustomRoot] = useState<string | null>(null);
  const rootMenuRef = useRef<HTMLDivElement>(null);
  useClickOutside(
    rootMenuRef,
    () => {
      setRootMenuOpen(false);
      setCustomRoot(null);
    },
    rootMenuOpen
  );

  const selectRoot = (root: string) => {
    setRootMenuOpen(false);
    setCustomRoot(null);
    if (root.trim() && root !== assetsRoot) void changeAssetsRoot(root);
  };

  const rootSuggestions = ASSETS_ROOT_SUGGESTIONS.includes(assetsRoot)
    ? ASSETS_ROOT_SUGGESTIONS
    : [assetsRoot, ...ASSETS_ROOT_SUGGESTIONS];

  // Pick mode shows only what's pickable (images) plus folders to navigate into.
  const visibleAssets = pick
    ? sortedAssets.filter((a) => a.isDirectory || isImageFile(a.name))
    : sortedAssets;

  /** Clicking an item: folders navigate; in pick mode files are the pick target. */
  const handleItemClick = (asset: Asset) => {
    if (asset.isDirectory) navigateToFolder(asset);
    else if (pick) pick.onPick(asset);
  };
  const itemModeClass = (asset: Asset) =>
    asset.isDirectory ? ' is-folder' : pick ? ' is-pickable' : '';

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
          <h3>{pick ? pick.title : 'Assets'}</h3>
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
              <button className="assets-search-clear" onClick={clearSearchQuery}>
                <CloseIcon size={12} />
              </button>
            )}
          </div>

          {/* Breadcrumb navigation. The root crumb navigates home; the chevron
              beside it re-points the panel at a different folder. */}
          {!searchQuery && (
            <div className="assets-breadcrumb">
              <div className="assets-root-picker" ref={rootMenuRef}>
                <button
                  className={`assets-breadcrumb-btn ${breadcrumbs.length === 1 ? 'active' : ''}`}
                  onClick={() => setCurrentPath('')}
                >
                  {assetsRoot}
                </button>
                <button
                  className="assets-root-toggle"
                  title="Change assets folder"
                  onClick={() => setRootMenuOpen((o) => !o)}
                >
                  <ChevronIcon size={12} />
                </button>
                {rootMenuOpen && (
                  <div className="assets-root-menu">
                    {rootSuggestions.map((root) => (
                      <button
                        key={root}
                        className={`assets-root-item ${root === assetsRoot ? 'active' : ''}`}
                        onClick={() => selectRoot(root)}
                      >
                        <FolderIcon size={13} />
                        <span>{root}</span>
                        {root === assetsRoot && <CheckIcon size={12} />}
                      </button>
                    ))}
                    {customRoot === null ? (
                      <button className="assets-root-item" onClick={() => setCustomRoot('')}>
                        <EditIcon size={13} />
                        <span>Custom folder…</span>
                      </button>
                    ) : (
                      <div className="assets-root-custom">
                        <input
                          type="text"
                          value={customRoot}
                          onChange={(e) => setCustomRoot(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') selectRoot(customRoot);
                            if (e.key === 'Escape') setCustomRoot(null);
                          }}
                          placeholder="e.g. src/images"
                          autoFocus
                          autoComplete="off"
                          autoCorrect="off"
                          autoCapitalize="off"
                          spellCheck={false}
                        />
                        <button
                          className="assets-new-folder-confirm"
                          onClick={() => selectRoot(customRoot)}
                        >
                          <CheckIcon size={14} />
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
              {breadcrumbs.slice(1).map((crumb, index) => (
                <span key={crumb.path} className="assets-breadcrumb-item">
                  <ChevronRightIcon size={12} />
                  <button
                    className={`assets-breadcrumb-btn ${
                      index === breadcrumbs.length - 2 ? 'active' : ''
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
            ) : visibleAssets.length === 0 ? (
              <div className="assets-empty">
                <div className="assets-empty-icon">
                  {searchQuery ? <SearchIcon size={32} /> : <ImageIcon size={32} />}
                </div>
                <p>
                  {searchQuery
                    ? `No ${pick ? 'images' : 'assets'} matching "${searchQuery}"`
                    : `No ${pick ? 'images' : 'assets'} in this folder`}
                </p>
                {!searchQuery && (
                  <p className="assets-empty-hint">Drag and drop files here or click Upload</p>
                )}
              </div>
            ) : viewMode === 'list' ? (
              <div className="assets-list">
                {visibleAssets.map((asset) => (
                  <div key={asset.path} className={`assets-item${itemModeClass(asset)}`}>
                    <div className="assets-item-main" onClick={() => handleItemClick(asset)}>
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
                {visibleAssets.map((asset) => (
                  <div
                    key={asset.path}
                    className={`assets-grid-item${itemModeClass(asset)}`}
                    onClick={() => handleItemClick(asset)}
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
