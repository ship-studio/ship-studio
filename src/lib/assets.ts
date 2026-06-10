/**
 * Asset management functions for the project's assets folder.
 *
 * These functions wrap Tauri commands for managing files in a project's
 * assets folder — listing, uploading, deleting, renaming assets. The folder
 * defaults to `/public` but can be re-pointed per project (e.g. `src/assets`
 * for Astro image pipelines) via get/setAssetsRoot.
 *
 * @module lib/assets
 */

import { invoke } from '@tauri-apps/api/core';

/** Folder the Assets panel manages when no per-project override is set. */
export const DEFAULT_ASSETS_ROOT = 'public';

/**
 * Get the folder (relative to the project) the Assets panel manages.
 * Returns "public" unless the project overrides it.
 */
export async function getAssetsRoot(projectPath: string): Promise<string> {
  return invoke<string>('get_assets_root', { projectPath });
}

/**
 * Point the Assets panel at a different folder (persisted per project).
 * Creates the folder if it doesn't exist; returns the normalized root.
 */
export async function setAssetsRoot(projectPath: string, root: string): Promise<string> {
  return invoke<string>('set_assets_root', { projectPath, root });
}

/**
 * Represents a file or folder in the /public directory
 */
export interface Asset {
  /** File or folder name */
  name: string;
  /** Relative path from /public (e.g., "images/logo.png") */
  path: string;
  /** Full filesystem path */
  fullPath: string;
  /** File size in bytes (0 for directories) */
  size: number;
  /** Whether this is a directory */
  isDirectory: boolean;
  /** Last modified timestamp in milliseconds since Unix epoch */
  modifiedAt: number;
}

/**
 * List all assets in the /public folder (recursive)
 */
export async function listAssets(projectPath: string): Promise<Asset[]> {
  const assets = await invoke<
    Array<{
      name: string;
      path: string;
      full_path: string;
      size: number;
      is_directory: boolean;
      modified_at: number;
    }>
  >('list_assets', { projectPath });

  return assets.map((a) => ({
    name: a.name,
    path: a.path,
    fullPath: a.full_path,
    size: a.size,
    isDirectory: a.is_directory,
    modifiedAt: a.modified_at,
  }));
}

/**
 * Upload a file to /public (or subfolder)
 * @param projectPath - Path to the project
 * @param destination - Destination path within /public (e.g., "/" or "/images")
 * @param fileName - Name for the uploaded file
 * @param fileData - File contents as byte array
 */
export async function uploadAsset(
  projectPath: string,
  destination: string,
  fileName: string,
  fileData: number[]
): Promise<Asset> {
  const result = await invoke<{
    name: string;
    path: string;
    full_path: string;
    size: number;
    is_directory: boolean;
    modified_at: number;
  }>('upload_asset', { projectPath, destination, fileName, fileData });

  return {
    name: result.name,
    path: result.path,
    fullPath: result.full_path,
    size: result.size,
    isDirectory: result.is_directory,
    modifiedAt: result.modified_at,
  };
}

/**
 * Delete an asset
 * @param projectPath - Path to the project
 * @param assetPath - Relative path of the asset within /public
 */
export async function deleteAsset(projectPath: string, assetPath: string): Promise<void> {
  await invoke('delete_asset', { projectPath, assetPath });
}

/**
 * Rename an asset
 * @param projectPath - Path to the project
 * @param assetPath - Relative path of the asset within /public
 * @param newName - New name for the asset
 */
export async function renameAsset(
  projectPath: string,
  assetPath: string,
  newName: string
): Promise<Asset> {
  const result = await invoke<{
    name: string;
    path: string;
    full_path: string;
    size: number;
    is_directory: boolean;
    modified_at: number;
  }>('rename_asset', { projectPath, assetPath, newName });

  return {
    name: result.name,
    path: result.path,
    fullPath: result.full_path,
    size: result.size,
    isDirectory: result.is_directory,
    modifiedAt: result.modified_at,
  };
}

/**
 * Create a folder in /public
 * @param projectPath - Path to the project
 * @param folderPath - Path for the new folder within /public
 */
export async function createAssetFolder(projectPath: string, folderPath: string): Promise<void> {
  await invoke('create_asset_folder', { projectPath, folderPath });
}

/**
 * Helper to format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Helper to get file extension
 */
function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  return lastDot !== -1 ? filename.slice(lastDot + 1).toLowerCase() : '';
}

/**
 * Helper to check if a file is an image
 */
export function isImageFile(filename: string): boolean {
  const ext = getFileExtension(filename);
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'bmp'].includes(ext);
}
