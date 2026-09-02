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

import { invoke } from '@tauri-apps/api/core';
import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { logger } from './logger';

/** Information about an available update */
export interface UpdateInfo {
  /** New version string (e.g., "0.2.0") */
  version: string;
  /** Release notes/changelog */
  body: string | undefined;
  /** Release date */
  date: string | undefined;
}

interface MockUpdateHandle {
  kind: 'mock-update';
}

export type UpdateHandle = Update | MockUpdateHandle;

const MOCK_UPDATE: MockUpdateHandle = { kind: 'mock-update' };
const MOCK_UPDATE_VERSION = '99.0.0-dev';
const MOCK_UPDATE_PROGRESS = [8, 19, 37, 58, 76, 91, 100];
const MOCK_UPDATE_STEP_MS = 600;

/** True only in a Vite development build explicitly started with the mock flag. */
export function isMockUpdateSimulationEnabled(): boolean {
  return import.meta.env.DEV && import.meta.env.VITE_MOCK_UPDATE === '1';
}

function isMockUpdate(update: UpdateHandle): update is MockUpdateHandle {
  return 'kind' in update && update.kind === 'mock-update';
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Current update state */
export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; update: UpdateHandle; info: UpdateInfo }
  | { status: 'downloading'; progress: number }
  | { status: 'ready' }
  | { status: 'error'; message: string };

/**
 * True when the updater plugin fetched a manifest that has no entry for the
 * running platform ("the platform `windows-x86_64` was not found on the
 * response `platforms` object"). Happens when a client reads a manifest that
 * was published for another OS — e.g. Windows reading the macOS-only
 * `latest.json` (issue #512). That's "no update available for this
 * platform", not a failure.
 */
export function isPlatformMissingFromManifest(message: string): boolean {
  return /platform .* was not found on the response/i.test(message);
}

/**
 * Check if an update is available.
 * @returns Update object if available, null otherwise
 */
export async function checkForUpdate(): Promise<{ update: UpdateHandle; info: UpdateInfo } | null> {
  if (isMockUpdateSimulationEnabled()) {
    return {
      update: MOCK_UPDATE,
      info: {
        version: MOCK_UPDATE_VERSION,
        date: undefined,
        body: `## What's New in v${MOCK_UPDATE_VERSION}

- **Safer update previews** - Exercise every updater state without downloading or replacing the development app.
- **Visible progress** - Watch the sidebar banner fill from left to right as the simulated download advances.
- **Repeatable restart** - The restart action resets this mock flow so it can be tested again immediately.`,
      },
    };
  }

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
    const message = error instanceof Error ? error.message : String(error);
    // The manifest fetched fine but simply has no entry for this platform
    // (e.g. the Windows manifest wasn't carried forward onto the "latest"
    // release). Treat as "no update available" rather than an error — there
    // is nothing the user can do about it, and it resolves itself when the
    // next platform release lands (issue #512).
    if (isPlatformMissingFromManifest(message)) {
      logger.warn(
        '[Updater] Update manifest has no entry for this platform; treating as no update',
        {
          error: message,
        }
      );
      return null;
    }
    // A failed check is expected/recoverable (offline, DNS blip) — the app
    // keeps working and retries later. logger.error would auto-file a bug
    // report for every routine network hiccup (issue #490).
    logger.warn('[Updater] Failed to check for updates', {
      error: message,
    });
    throw error;
  }
}

/**
 * Download and install an update.
 * @param update - The update object from checkForUpdate
 * @param onProgress - Optional callback for download progress (0-100)
 */
export async function downloadAndInstall(
  update: UpdateHandle,
  onProgress?: (progress: number) => void
): Promise<void> {
  if (isMockUpdateSimulationEnabled() && isMockUpdate(update)) {
    logger.info('[Updater] Starting simulated development update');
    for (const progress of MOCK_UPDATE_PROGRESS) {
      await wait(MOCK_UPDATE_STEP_MS);
      onProgress?.(progress);
    }
    logger.info('[Updater] Simulated development update finished');
    return;
  }

  if (isMockUpdate(update)) {
    throw new Error('Mock update handles cannot be installed outside development simulation');
  }

  let downloaded = 0;
  let contentLength = 0;

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case 'Started':
        contentLength = event.data.contentLength ?? 0;
        logger.info(`[Updater] Download started, size: ${contentLength}`);
        break;
      case 'Progress': {
        downloaded += event.data.chunkLength;
        const progress = contentLength > 0 ? Math.round((downloaded / contentLength) * 100) : 0;
        onProgress?.(progress);
        break;
      }
      case 'Finished':
        logger.info('[Updater] Download finished');
        onProgress?.(100);
        break;
    }
  });
}

/**
 * Install a specific version of the application.
 * Downloads and installs the specified version, emitting 'rewind-progress' events.
 * @param version - Version string to install (e.g., "0.3.50")
 */
export async function installVersion(version: string): Promise<void> {
  return invoke<void>('install_version', { version });
}

/**
 * Restart the application to apply the update.
 */
export async function restartApp(): Promise<'simulated' | void> {
  if (isMockUpdateSimulationEnabled()) {
    logger.info('[Updater] Simulated restart complete');
    return 'simulated';
  }
  await relaunch();
}
