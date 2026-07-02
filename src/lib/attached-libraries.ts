/**
 * Attached libraries: local directories the user registers once and Ship Studio
 * rides along into every agent session via the agent's additional-directory
 * flag (e.g. Claude Code's `--add-dir`). Skills in the library load and its
 * files are readable; its CLAUDE.md is not loaded, so it can't override the
 * project's own instructions.
 *
 * The registry is populated only through a native folder picker (see
 * `addAttachedLibrary`), which is the trust boundary — the webview never
 * supplies a path directly.
 *
 * @module lib/attached-libraries
 */

import { invoke } from '@tauri-apps/api/core';

/** A directory attached to every agent session. Mirrors the Rust `AttachedLibrary`. */
export interface AttachedLibrary {
  /** Absolute, canonicalized path to the library directory. */
  path: string;
  /** Unix timestamp (ms) when the directory was attached. */
  added_at: number;
}

/** Every registered attached library, for the management UI. */
export async function listAttachedLibraries(): Promise<AttachedLibrary[]> {
  return invoke<AttachedLibrary[]>('list_attached_libraries');
}

/**
 * Canonical paths of attached libraries that currently exist on disk. Used at
 * agent launch to build the additional-directory flags; missing folders are
 * skipped by the backend so a moved/deleted library never breaks a spawn.
 */
export async function attachedLibraryDirs(): Promise<string[]> {
  return invoke<string[]>('attached_library_dirs');
}

/**
 * Open a native folder picker and register the chosen directory.
 * @returns The registered path, or null if the user cancelled.
 */
export async function addAttachedLibrary(): Promise<string | null> {
  return invoke<string | null>('add_attached_library');
}

/** Remove an attached library from the registry (does not delete the folder). */
export async function removeAttachedLibrary(path: string): Promise<void> {
  return invoke<void>('remove_attached_library', { path });
}
