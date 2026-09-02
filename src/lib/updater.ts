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
import { getVersion } from '@tauri-apps/api/app';
import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { logger } from './logger';

/** Injected by Vite/Vitest from package.json; absent in bare test runners. */
declare const __APP_VERSION__: string | undefined;

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

interface ParsedVersion {
  release: number[];
  prerelease: string[];
}

/** Parse a `v?1.2.3(-pre)(+build)` string. Returns null when it isn't one. */
function parseVersion(value: string): ParsedVersion | null {
  const trimmed = value.trim().replace(/^v/i, '');
  const match = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(trimmed);
  if (!match) return null;
  return {
    release: match[1].split('.').map((part) => Number(part)),
    prerelease: match[2] ? match[2].split('.') : [],
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  // Semver precedence: a release outranks any prerelease of the same numbers.
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const diff = Number(a) - Number(b);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * Compare two version strings. Returns -1/0/1, or null when either side isn't
 * a version we can reason about (never guess — see "Never Assume Data").
 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;

  const length = Math.max(left.release.length, right.release.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left.release[index] ?? 0) - (right.release[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * True when `candidate` is strictly newer than `current`. An uncomparable pair
 * counts as newer: swallowing a real update is worse than one odd banner.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const result = compareVersions(candidate, current);
  if (result === null) return true;
  return result > 0;
}

/**
 * The version actually running, as the highest of the two sources that can
 * disagree:
 *
 * - `getVersion()` — the compiled binary's `tauri.conf.json` version. In
 *   `tauri dev` this is whatever the last `cargo` build baked in, so it goes
 *   stale the moment the version is bumped without a Rust rebuild.
 * - `__APP_VERSION__` — package.json at bundle time. The Vite dev server
 *   re-reads it, so it is the fresher of the two in development.
 *
 * Taking the max means a stale dev binary can't make the just-released version
 * look like an available update.
 */
export async function getRunningAppVersion(): Promise<string | null> {
  const candidates: string[] = [];

  if (typeof __APP_VERSION__ === 'string' && __APP_VERSION__) {
    candidates.push(__APP_VERSION__);
  }

  try {
    const binaryVersion = await getVersion();
    if (binaryVersion) candidates.push(binaryVersion);
  } catch (error) {
    logger.warn('[Updater] Could not read the running app version', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (candidates.length === 0) return null;
  return candidates.reduce((highest, candidate) =>
    (compareVersions(candidate, highest) ?? 0) > 0 ? candidate : highest
  );
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
      // Never offer an update to the version already running (or an older
      // one). The plugin compares against the compiled binary's version, which
      // in `tauri dev` can lag behind a freshly bumped package.json and turn
      // the current release into a phantom "update available".
      const currentVersion = await getRunningAppVersion();
      if (currentVersion && !isNewerVersion(update.version, currentVersion)) {
        logger.info('[Updater] Offered version is not newer than the running app; ignoring', {
          offeredVersion: update.version,
          currentVersion,
        });
        return null;
      }

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
