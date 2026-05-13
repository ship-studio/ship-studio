/**
 * External project management utilities.
 *
 * Provides functions for registering and managing projects
 * that live outside the ~/ShipStudio directory.
 *
 * @module lib/external-projects
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * Opens a native folder picker and registers the selected folder as an external project.
 * @returns The path of the registered project, or null if cancelled
 */
export async function registerExternalProject(): Promise<string | null> {
  return invoke<string | null>('register_external_project');
}

/**
 * Removes an external project from the registry (does not delete files).
 * @param path - Absolute path to the external project
 */
export async function unregisterExternalProject(path: string): Promise<void> {
  return invoke<void>('unregister_external_project', { path });
}

/**
 * Returns true when the given path is tracked as an external project
 * (registered via `register_external_project`) rather than living inside
 * ~/ShipStudio.
 */
export async function isProjectExternal(path: string): Promise<boolean> {
  return invoke<boolean>('is_project_external', { path });
}
