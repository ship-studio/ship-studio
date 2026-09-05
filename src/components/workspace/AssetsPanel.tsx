/**
 * AssetsPanel component for managing files in the /public folder.
 *
 * Provides a modal interface to:
 * - View assets in the /public folder (recursive listing)
 * - Upload new files via drag-and-drop or file picker
 * - Rename and delete assets
 * - Create new folders
 * - Copy asset paths for use in code
 * - Download assets to disk via a native save dialog
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
import { formatFileSize, isImageFile, type Asset } from '../../lib/assets';
import { useAssetManagement } from '../../hooks/useAssetManagement';
import { Dropdown, DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { ModalFrame } from '../primitives/ModalFrame';
import { Tabs, TabsList, TabsTab } from '../primitives/Tabs';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useModal } from '../../contexts/ModalContext';
import {
  CloseIcon,
  CopyIcon,
  DownloadIcon,
  TrashIcon,
  EditIcon,
  EditFieldIcon,
  UploadIcon,
  FolderIcon,
  FileIcon,
  ImageIcon,
  ChevronIcon,
  ChevronRightIcon,
  FolderPlusIcon,
  CheckIcon,
  SearchIcon,
  GridIcon,
  ListIcon,
  MoreHorizontalIcon,
} from '@/components/icons';

/** Common asset folders offered in the root picker. */
const ASSETS_ROOT_SUGGESTIONS = ['public', 'src/assets', 'assets', 'static'];

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
    handleDownload,
    navigateToFolder,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
  } = useAssetManagement({ projectPath, isOpen, onToast });

  // --- Assets root picker state ---
  // null = not editing; string = custom folder input value
  const [customRoot, setCustomRoot] = useState<string | null>(null);
  const rootPickerRef = useRef<HTMLDivElement>(null);
  // Escape-cancelled renames must not be committed by the unmounting input's
  // blur — the blur closure still holds the pre-cancel renameTarget.
  const renameCancelledRef = useRef(false);
  const commitRenameOnBlur = () => {
    if (renameCancelledRef.current) {
      renameCancelledRef.current = false;
      return;
    }
    void handleRename();
  };
  const renameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void handleRename();
    if (e.key === 'Escape') {
      // Claim the key so the enclosing modal doesn't also close (see
      // ModalFrame's escape handling), and cancel without committing.
      e.stopPropagation();
      renameCancelledRef.current = true;
      setRenameTarget(null);
    }
  };

  const selectRoot = (root: string) => {
    setCustomRoot(null);
    if (root.trim() && root !== assetsRoot) void changeAssetsRoot(root);
  };

  /** Close the root menu from the custom-folder input (Enter / confirm click).
   *  The Dropdown primitive owns its open state, so close it the way a user
   *  would — by toggling the trigger. Suggestion rows don't need this:
   *  DropdownItem auto-closes on select. */
  const closeRootMenu = () => {
    rootPickerRef.current
      ?.querySelector<HTMLButtonElement>('.assets-root-toggle[aria-expanded="true"]')
      ?.click();
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

  /** Keep the same action menu available from both asset layouts. */
  const renderAssetActions = (asset: Asset) => (
    <Dropdown
      portal
      align="right"
      menuClassName="assets-actions-menu"
      trigger={(p) => (
        <IconButton
          variant="default"
          icon={<MoreHorizontalIcon size={14} />}
          title="Asset actions"
          aria-label="Asset actions"
          {...p}
        />
      )}
    >
      {!asset.isDirectory && (
        <DropdownItem icon={<DownloadIcon size={14} />} onSelect={() => void handleDownload(asset)}>
          <span>Download</span>
        </DropdownItem>
      )}
      <DropdownItem
        icon={copiedPath === asset.path ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
        onSelect={() => void handleCopyPath(asset)}
      >
        <span>Copy path</span>
      </DropdownItem>
      <DropdownItem icon={<EditFieldIcon size={14} />} onSelect={() => startRename(asset)}>
        <span>Rename</span>
      </DropdownItem>
      <DropdownDivider />
      <DropdownItem
        variant="danger"
        icon={deleteTarget === asset.path ? <CheckIcon size={14} /> : <TrashIcon size={14} />}
        onSelect={() => void handleDeleteClick(asset)}
      >
        <span>{deleteTarget === asset.path ? 'Confirm delete' : 'Delete'}</span>
      </DropdownItem>
    </Dropdown>
  );

  if (!isOpen) return null;

  return (
    <ModalFrame
      isOpen
      onClose={onClose}
      title={pick ? pick.title : 'Assets'}
      className="assets-panel-modal"
    >
      <div className="assets-panel-content">
        {/* Toolbar */}
        <div className="assets-toolbar">
          <Button
            variant="primary"
            leftIcon={<UploadIcon size={14} />}
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
          >
            {isUploading ? 'Uploading...' : 'Upload'}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={(e) => void handleUpload(e.target.files)}
            style={{ display: 'none' }}
          />
          <Button
            variant="default"
            leftIcon={<FolderPlusIcon size={14} />}
            onClick={() => setShowNewFolder(true)}
          >
            New Folder
          </Button>
          <div className="assets-toolbar-spacer" />
          <Tabs
            value={viewMode}
            mode="navigation"
            onValueChange={(next) => setViewMode(next as typeof viewMode)}
            size="default"
          >
            <TabsList className="assets-view-toggle" aria-label="Asset view">
              <TabsTab
                value="list"
                className="button--icon-only"
                leftIcon={<ListIcon size={14} />}
                aria-label="List view"
                title="List view"
              />
              <TabsTab
                value="grid"
                className="button--icon-only"
                leftIcon={<GridIcon size={14} />}
                aria-label="Grid view"
                title="Grid view"
              />
            </TabsList>
          </Tabs>
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
            <div className="assets-root-picker" ref={rootPickerRef}>
              <button
                className={`assets-breadcrumb-btn ${breadcrumbs.length === 1 ? 'active' : ''}`}
                onClick={() => setCurrentPath('')}
              >
                {assetsRoot}
              </button>
              <Dropdown
                menuClassName="assets-root-menu"
                onOpenChange={(open) => {
                  if (!open) setCustomRoot(null);
                }}
                trigger={(p) => (
                  <button
                    className="assets-root-toggle"
                    title="Change assets folder"
                    aria-label="Change assets folder"
                    {...p}
                  >
                    <ChevronIcon size={12} />
                  </button>
                )}
              >
                {rootSuggestions.map((root) => (
                  <DropdownItem
                    key={root}
                    icon={<FolderIcon size={13} />}
                    active={root === assetsRoot}
                    onSelect={() => selectRoot(root)}
                  >
                    <span>{root}</span>
                    {root === assetsRoot && <CheckIcon size={12} />}
                  </DropdownItem>
                ))}
                {customRoot === null ? (
                  <DropdownItem
                    icon={<EditIcon size={13} />}
                    keepOpen
                    onSelect={() => setCustomRoot('')}
                  >
                    <span>Custom folder…</span>
                  </DropdownItem>
                ) : (
                  <div className="assets-root-custom">
                    <input
                      type="text"
                      value={customRoot}
                      onChange={(e) => setCustomRoot(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          selectRoot(customRoot);
                          closeRootMenu();
                        }
                        if (e.key === 'Escape') {
                          // Back to the suggestion list — stop the event so
                          // the Dropdown's window-level ESC handler doesn't
                          // close the whole menu.
                          e.stopPropagation();
                          setCustomRoot(null);
                        }
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
                      onClick={() => {
                        selectRoot(customRoot);
                        closeRootMenu();
                      }}
                    >
                      <CheckIcon size={14} />
                    </button>
                  </div>
                )}
              </Dropdown>
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
            <button className="assets-new-folder-confirm" onClick={() => void handleCreateFolder()}>
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
                        onKeyDown={renameKeyDown}
                        onBlur={commitRenameOnBlur}
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
                  <div className="assets-item-actions">{renderAssetActions(asset)}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="assets-grid">
              {visibleAssets.map((asset) => (
                <div
                  key={asset.path}
                  className={`assets-grid-entry${itemModeClass(asset)}`}
                  onClick={() => handleItemClick(asset)}
                >
                  <div className="assets-grid-item">
                    <div className="assets-grid-preview">
                      {asset.isDirectory ? (
                        <FolderIcon size={32} />
                      ) : isImageFile(asset.name) ? (
                        <img src={convertFileSrc(asset.fullPath)} alt={asset.name} loading="lazy" />
                      ) : (
                        <FileIcon size={32} />
                      )}
                    </div>
                    <div className="assets-grid-actions">{renderAssetActions(asset)}</div>
                  </div>
                  <div className="assets-grid-info">
                    {renameTarget?.path === asset.path ? (
                      <input
                        type="text"
                        className="assets-rename-input"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={renameKeyDown}
                        onBlur={commitRenameOnBlur}
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
    </ModalFrame>
  );
}
