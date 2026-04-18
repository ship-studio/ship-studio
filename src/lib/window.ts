/**
 * Window management and compact mode utilities.
 *
 * Provides functions for:
 * - Entering/exiting compact mode
 * - Managing always-on-top state
 * - Saving/restoring window position
 * - Controlling window expansion state
 * - Multi-window port management
 *
 * Compact mode transforms Ship Studio into a minimal floating input bar
 * that can stay on top of other windows for easy access.
 *
 * @module lib/window
 */

import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * Enter compact mode - transforms window to minimal floating bar.
 * Removes window decorations, resizes to compact dimensions,
 * and restores saved position/always-on-top state.
 */
export async function enterCompactMode(): Promise<void> {
  return invoke('enter_compact_mode');
}

/**
 * Exit compact mode - restores window to full size.
 * Saves current position before exiting, restores decorations,
 * and centers the window on screen.
 */
export async function exitCompactMode(): Promise<void> {
  return invoke('exit_compact_mode');
}

/**
 * Toggle always-on-top state for the window.
 * When enabled, window stays above all other windows.
 * State is persisted across sessions.
 *
 * @param enabled - Whether to enable always-on-top
 */
export async function setAlwaysOnTop(enabled: boolean): Promise<void> {
  return invoke('set_always_on_top', { enabled });
}

/**
 * Start native window drag.
 * Call this on mousedown to allow user to drag the window.
 * The window will follow the cursor until mouse is released.
 */
export async function startWindowDrag(): Promise<void> {
  return invoke('start_window_drag');
}

/**
 * Focus the window and bring it to front.
 * Useful after opening external apps (like a browser) that may steal focus.
 */
export async function focusWindow(): Promise<void> {
  return invoke('focus_window');
}

/**
 * Set the window title dynamically.
 * Useful for showing project name in the title bar.
 *
 * @param title - The new window title
 */
export async function setWindowTitle(title: string): Promise<void> {
  return invoke('set_window_title', { title });
}

/**
 * Get the current window's label.
 * Used for multi-window support to identify which window is making requests.
 *
 * @returns The window label (e.g., "main" or "project-12345")
 */
export function getWindowLabel(): string {
  return getCurrentWindow().label;
}

/**
 * Find and reserve an available port for a project's dev server.
 * Keyed by (windowLabel, projectPath) so multiple projects in the same
 * window can each hold their own port simultaneously.
 *
 * @param projectPath - Absolute path of the project requesting a port
 * @param preferredPort - Preferred port to start searching from
 * @returns The reserved port number
 */
export async function findAndReservePort(
  projectPath: string,
  preferredPort: number
): Promise<number> {
  const windowLabel = getWindowLabel();
  return invoke<number>('find_and_reserve_port', {
    windowLabel,
    projectPath,
    preferredPort,
  });
}

/**
 * Release the reserved port for a specific project in this window.
 * Use this when a project's dev server is deliberately stopped or the
 * project is being torn down. Window-close cleanup is handled separately.
 */
export async function releaseReservedPort(projectPath: string): Promise<void> {
  const windowLabel = getWindowLabel();
  return invoke('release_reserved_port', { windowLabel, projectPath });
}

/**
 * Look up the port already reserved for a given project in this window, if any.
 */
export async function getReservedPortForProject(projectPath: string): Promise<number | null> {
  const windowLabel = getWindowLabel();
  return invoke<number | null>('get_reserved_port_for_window', {
    windowLabel,
    projectPath,
  });
}

/**
 * Check if a project is already open in another window.
 * Returns the window label if open, or null if not.
 *
 * @param projectPath - Path to the project
 * @returns Window label if project is open, null otherwise
 */
export async function getProjectWindow(projectPath: string): Promise<string | null> {
  return invoke<string | null>('get_project_window', { projectPath });
}

/**
 * Focus a window by its label.
 * Used to bring an existing project window to the front.
 *
 * @param windowLabel - Label of the window to focus
 */
export async function focusWindowByLabel(windowLabel: string): Promise<void> {
  return invoke('focus_window_by_label', { windowLabel });
}
