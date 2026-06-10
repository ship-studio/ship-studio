/**
 * Hook for managing asset state and operations in the /public folder.
 *
 * Encapsulates: asset loading, upload, delete, rename, folder creation,
 * path copying, folder navigation, drag-and-drop, search, and view mode.
 *
 * @module hooks/useAssetManagement
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  listAssets,
  uploadAsset,
  deleteAsset,
  renameAsset,
  createAssetFolder,
  getAssetsRoot,
  setAssetsRoot,
  DEFAULT_ASSETS_ROOT,
  type Asset,
} from '../lib/assets';
import { trackEvent, trackError, trackSearch } from '../lib/analytics';
import { logger } from '../lib/logger';

export interface UseAssetManagementParams {
  /** Absolute path to the project directory */
  projectPath: string;
  /** Whether the assets panel is open */
  isOpen: boolean;
  /** Optional callback to show toast notifications */
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

export interface Breadcrumb {
  name: string;
  path: string;
}

export function useAssetManagement({ projectPath, isOpen, onToast }: UseAssetManagementParams) {
  // --- State ---
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
  const [assetsRoot, setAssetsRootState] = useState(DEFAULT_ASSETS_ROOT);

  // --- Refs ---
  const deleteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  // --- Load assets ---
  const loadAssets = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const allAssets = await listAssets(projectPath);
      setAssets(allAssets);
    } catch (e) {
      trackError('asset_load', e, 'Workspace');
      setError('Failed to load assets');
      logger.error('Failed to load assets', { error: e instanceof Error ? e.message : String(e) });
    } finally {
      setIsLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    if (isOpen) {
      void loadAssets();
      setCurrentPath('');
      setSearchQuery('');
      getAssetsRoot(projectPath)
        .then(setAssetsRootState)
        .catch((e) =>
          logger.warn('Failed to load assets root', {
            error: e instanceof Error ? e.message : String(e),
          })
        );
    }
  }, [isOpen, loadAssets, projectPath]);

  // Re-point the panel at a different folder (persisted per project).
  const changeAssetsRoot = async (root: string) => {
    try {
      const saved = await setAssetsRoot(projectPath, root);
      setAssetsRootState(saved);
      setCurrentPath('');
      setSearchQuery('');
      await loadAssets();
      void trackEvent('assets_root_changed', { $screen_name: 'Workspace' });
      onToast?.(`Assets folder set to ${saved}`, 'success');
    } catch (e) {
      trackError('assets_root_change', e, 'Workspace');
      const msg = e instanceof Error ? e.message : 'Failed to change assets folder';
      setError(msg);
      onToast?.(msg, 'error');
    }
  };

  // --- Computed values ---

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
  const breadcrumbs: Breadcrumb[] = [
    { name: assetsRoot, path: '' },
    ...pathParts.map((part, index) => ({
      name: part,
      path: pathParts.slice(0, index + 1).join('/'),
    })),
  ];

  // --- Handlers ---

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
      void trackEvent('asset_uploaded', { file_count: files.length, $screen_name: 'Workspace' });
      onToast?.(
        files.length === 1 ? `Uploaded ${files[0].name}` : `Uploaded ${files.length} files`,
        'success'
      );
    } catch (e) {
      trackError('asset_upload', e, 'Workspace');
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
        void trackEvent('asset_deleted', {
          is_folder: asset.isDirectory,
          $screen_name: 'Workspace',
        });
        await loadAssets();
        onToast?.(`Deleted ${asset.name}`, 'success');
      } catch (e) {
        trackError('asset_delete', e, 'Workspace');
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
      void trackEvent('asset_renamed', { $screen_name: 'Workspace' });
      await loadAssets();
      onToast?.(`Renamed to ${renameValue.trim()}`, 'success');
    } catch (e) {
      trackError('asset_rename', e, 'Workspace');
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
      void trackEvent('asset_folder_created', { $screen_name: 'Workspace' });
      await loadAssets();
      onToast?.(`Created folder ${newFolderName.trim()}`, 'success');
    } catch (e) {
      trackError('asset_folder_create', e, 'Workspace');
      const msg = e instanceof Error ? e.message : 'Failed to create folder';
      setError(msg);
      onToast?.(msg, 'error');
    } finally {
      setShowNewFolder(false);
      setNewFolderName('');
    }
  };

  // Handle copy path. Files under /public are served from the site root, so
  // copy a web path; for any other root copy a project-relative path (useful
  // for imports, e.g. src/assets/logo.png).
  const handleCopyPath = async (asset: Asset) => {
    const webPath =
      assetsRoot === DEFAULT_ASSETS_ROOT ? `/${asset.path}` : `${assetsRoot}/${asset.path}`;
    try {
      await navigator.clipboard.writeText(webPath);
      setCopiedPath(asset.path);
      setTimeout(() => setCopiedPath(null), 2000);
      onToast?.(`Copied ${webPath}`, 'success');
    } catch (e) {
      logger.error('Failed to copy path', { error: e instanceof Error ? e.message : String(e) });
    }
  };

  // Navigate into folder
  const navigateToFolder = (asset: Asset) => {
    if (asset.isDirectory) {
      setCurrentPath(asset.path);
    }
  };

  // --- Drag and drop handlers ---
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

  // --- Search handler with analytics ---
  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    trackSearch('asset_search', value, 'Workspace');
  };

  return {
    // State
    assets,
    currentPath,
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
    setSearchQuery: handleSearchChange,
    clearSearchQuery: () => setSearchQuery(''),
    deleteTarget,
    assetsRoot,
    changeAssetsRoot,

    // Refs
    fileInputRef,
    dropZoneRef,

    // Computed values
    sortedAssets,
    breadcrumbs,

    // Handlers
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
  };
}
