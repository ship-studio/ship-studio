/**
 * App update utilities using Tauri's updater plugin.
 *
 * Provides functions for:
 * - Checking for available updates
 * - Downloading and installing updates
 * - Restarting the app after update
 *
 * @module lib/updater
 */

import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

/** Information about an available update */
export interface UpdateInfo {
  /** New version string (e.g., "0.2.0") */
  version: string;
  /** Release notes/changelog */
  body: string | undefined;
  /** Release date */
  date: string | undefined;
}

/** Current update state */
export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; update: Update; info: UpdateInfo }
  | { status: 'downloading'; progress: number }
  | { status: 'ready' }
  | { status: 'error'; message: string };

/**
 * Check if an update is available.
 * @returns Update object if available, null otherwise
 */
export async function checkForUpdate(): Promise<{ update: Update; info: UpdateInfo } | null> {
  try {
    const update = await check();
    if (update) {
      return {
        update,
        info: {
          version: update.version,
          body: update.body,
          date: update.date,
        },
      };
    }
    return null;
  } catch (error) {
    console.error('[Updater] Failed to check for updates:', error);
    throw error;
  }
}

/**
 * Download and install an update.
 * @param update - The update object from checkForUpdate
 * @param onProgress - Optional callback for download progress (0-100)
 */
export async function downloadAndInstall(
  update: Update,
  onProgress?: (progress: number) => void
): Promise<void> {
  let downloaded = 0;
  let contentLength = 0;

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case 'Started':
        contentLength = event.data.contentLength ?? 0;
        console.warn(`[Updater] Download started, size: ${contentLength}`);
        break;
      case 'Progress': {
        downloaded += event.data.chunkLength;
        const progress = contentLength > 0 ? Math.round((downloaded / contentLength) * 100) : 0;
        onProgress?.(progress);
        break;
      }
      case 'Finished':
        console.warn('[Updater] Download finished');
        onProgress?.(100);
        break;
    }
  });
}

/**
 * Restart the application to apply the update.
 */
export async function restartApp(): Promise<void> {
  await relaunch();
}
